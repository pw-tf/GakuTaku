/**
 * Credits / licensing. The JMdict/JMnedict/KANJIDIC dictionaries are free under the EDRDG
 * license but REQUIRE visible attribution (build plan §6), so this must remain reachable.
 */
export function Attribution() {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 text-sm text-slate-300">
      <h1 className="text-xl font-bold text-slate-100">Credits &amp; Licenses</h1>

      <section>
        <h2 className="font-semibold text-slate-100">Dictionary data</h2>
        <p>
          This application uses the JMdict, JMnedict, and KANJIDIC dictionary files. These are the
          property of the{' '}
          <a className="text-indigo-400 underline" href="https://www.edrdg.org/" target="_blank" rel="noreferrer">
            Electronic Dictionary Research and Development Group (EDRDG)
          </a>
          , and are used in conformance with the Group's{' '}
          <a className="text-indigo-400 underline" href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noreferrer">
            licence
          </a>
          . Data is sourced via{' '}
          <a className="text-indigo-400 underline" href="https://github.com/scriptin/jmdict-simplified" target="_blank" rel="noreferrer">
            jmdict-simplified
          </a>
          .
        </p>
      </section>

      <section>
        <h2 className="font-semibold text-slate-100">Tokenizer</h2>
        <p>
          Japanese morphological analysis by{' '}
          <a className="text-indigo-400 underline" href="https://github.com/sglkc/kuromoji.js" target="_blank" rel="noreferrer">
            kuromoji.js
          </a>{' '}
          (Apache License 2.0) with the IPADIC dictionary.
        </p>
      </section>

      <section>
        <h2 className="font-semibold text-slate-100">Spaced repetition</h2>
        <p>Scheduling powered by FSRS via the open-source ts-fsrs library.</p>
      </section>
    </div>
  );
}
