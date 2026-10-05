/**
 * Minimal protobuf wire-format reader for the handful of Anki messages the modern `.apkg`
 * (export version 3) embeds: `PackageMetadata` (the `meta` file), `MediaEntries` (the `media`
 * file), and the config blobs in the schema-18 SQLite tables (`notetypes`, `templates`, `decks`,
 * `deck_config`). Varints, floats (fixed32, packed or not) and length-delimited fields are read;
 * 64-bit fixed fields are skipped. Field numbers come from Anki's proto/anki/{notetypes,import_export}.proto.
 */

export type PbValue = number | Uint8Array;

/** Decode one message level into field-number → values (repeated fields keep all occurrences). */
export function decodeFields(buf: Uint8Array): Map<number, PbValue[]> {
  const out = new Map<number, PbValue[]>();
  let i = 0;
  const varint = (): number => {
    let shift = 0;
    let val = 0;
    for (;;) {
      const b = buf[i++];
      // Numbers (not bigints) are fine here: Anki ids are ms-epoch (< 2^53) and lengths are small.
      val += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) return val;
      shift += 7;
      if (shift > 63 || i > buf.length) throw new Error('Invalid protobuf varint');
    }
  };
  const push = (tag: number, v: PbValue) => {
    const arr = out.get(tag);
    if (arr) arr.push(v);
    else out.set(tag, [v]);
  };
  while (i < buf.length) {
    const key = varint();
    const tag = Math.floor(key / 8);
    const wire = key & 7;
    switch (wire) {
      case 0:
        push(tag, varint());
        break;
      case 1:
        i += 8;
        break;
      case 2: {
        const len = varint();
        push(tag, buf.subarray(i, i + len));
        i += len;
        break;
      }
      case 5:
        // fixed32: every fixed32 field in Anki's protos is a float.
        push(tag, new DataView(buf.buffer, buf.byteOffset + i, 4).getFloat32(0, true));
        i += 4;
        break;
      default:
        // Groups (3/4) aren't used by Anki's protos; bail rather than misparse.
        throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
    if (i > buf.length) throw new Error('Truncated protobuf message');
  }
  return out;
}

const utf8 = new TextDecoder();

/** A string field (last occurrence wins, per protobuf), or '' when absent. */
export function pbString(fields: Map<number, PbValue[]>, tag: number): string {
  const v = fields.get(tag)?.findLast((x): x is Uint8Array => x instanceof Uint8Array);
  return v ? utf8.decode(v) : '';
}

/** A varint field (last occurrence wins, per protobuf), or 0 when absent. */
export function pbUint(fields: Map<number, PbValue[]>, tag: number): number {
  const v = fields.get(tag)?.findLast((x): x is number => typeof x === 'number');
  return v ?? 0;
}

/** All occurrences of a repeated length-delimited (sub-message) field. */
export function pbMessages(fields: Map<number, PbValue[]>, tag: number): Uint8Array[] {
  return (fields.get(tag) ?? []).filter((x): x is Uint8Array => x instanceof Uint8Array);
}

/** A repeated float field, packed (one length-delimited blob) or not. */
export function pbFloats(fields: Map<number, PbValue[]>, tag: number): number[] {
  const out: number[] = [];
  for (const v of fields.get(tag) ?? []) {
    if (typeof v === 'number') out.push(v);
    else {
      const dv = new DataView(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i + 4 <= v.byteLength; i += 4) out.push(dv.getFloat32(i, true));
    }
  }
  return out;
}

/** A float (fixed32) field (last occurrence wins), or `fallback` when absent. */
export function pbFloat(fields: Map<number, PbValue[]>, tag: number, fallback = 0): number {
  const v = fields.get(tag)?.findLast((x): x is number => typeof x === 'number');
  return v ?? fallback;
}

/** Whether a field is present at all (proto3 `optional` fields). */
export const pbHas = (fields: Map<number, PbValue[]>, tag: number) => fields.has(tag);

/** First nested message, decoded (empty map when absent). */
export function pbMessage(fields: Map<number, PbValue[]>, tag: number): Map<number, PbValue[]> {
  const m = pbMessages(fields, tag)[0];
  return m ? decodeFields(m) : new Map();
}
