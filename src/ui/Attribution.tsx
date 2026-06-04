/**
 * Credits / licensing. JMdict/JMnedict/KANJIDIC are free under the EDRDG license but REQUIRE
 * visible attribution (build plan §6) — reachable from Settings → Credits.
 */
export function Attribution() {
  return (
    <div className="attrib">
      <h1>Credits &amp; Licenses</h1>

      <h2>Dictionary data</h2>
      <p>
        This application uses the JMdict, JMnedict, and KANJIDIC dictionary files. These are the
        property of the{' '}
        <a href="https://www.edrdg.org/" target="_blank" rel="noreferrer">Electronic Dictionary Research and Development Group (EDRDG)</a>,
        and are used in conformance with the Group's{' '}
        <a href="https://www.edrdg.org/edrdg/licence.html" target="_blank" rel="noreferrer">licence</a>.
        Data is sourced via{' '}
        <a href="https://github.com/scriptin/jmdict-simplified" target="_blank" rel="noreferrer">jmdict-simplified</a>.
      </p>

      <h2>Tokenizer</h2>
      <p>
        Japanese morphological analysis by{' '}
        <a href="https://github.com/sglkc/kuromoji.js" target="_blank" rel="noreferrer">kuromoji.js</a>{' '}
        (Apache License 2.0) with the IPADIC dictionary.
      </p>

      <h2>Spaced repetition</h2>
      <p>Scheduling powered by FSRS via the open-source ts-fsrs library.</p>

      <h2>Sample text</h2>
      <p lang="ja">夏目漱石「吾輩は猫である」（パブリックドメイン）</p>
    </div>
  );
}
