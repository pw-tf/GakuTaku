/**
 * Minimal protobuf wire-format reader for the handful of Anki messages the modern `.apkg`
 * (export version 3) embeds: `PackageMetadata` (the `meta` file), `MediaEntries` (the `media`
 * file), and the `Notetype.Config` / `Notetype.Template.Config` blobs in the schema-18 SQLite
 * `notetypes`/`templates` tables. We only ever need varints and length-delimited fields; anything
 * else is skipped. Field numbers come from Anki's proto/anki/{notetypes,import_export}.proto.
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

/** First occurrence of a length-delimited field, decoded as UTF-8 (or '' when absent). */
export function pbString(fields: Map<number, PbValue[]>, tag: number): string {
  const v = fields.get(tag)?.find((x): x is Uint8Array => x instanceof Uint8Array);
  return v ? utf8.decode(v) : '';
}

/** First occurrence of a varint field (or 0 when absent). */
export function pbUint(fields: Map<number, PbValue[]>, tag: number): number {
  const v = fields.get(tag)?.find((x): x is number => typeof x === 'number');
  return v ?? 0;
}

/** All occurrences of a repeated length-delimited (sub-message) field. */
export function pbMessages(fields: Map<number, PbValue[]>, tag: number): Uint8Array[] {
  return (fields.get(tag) ?? []).filter((x): x is Uint8Array => x instanceof Uint8Array);
}
