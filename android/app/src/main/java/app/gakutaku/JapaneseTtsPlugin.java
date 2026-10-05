package app.gakutaku;

import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/**
 * The device's text-to-speech engine for Japanese: speaks card text ({{tts}} tags and the
 * dictionary's listen button) and records sentences to audio files when mining. Android's WebView
 * has no Web Speech API, so the web layer calls this instead.
 */
@CapacitorPlugin(name = "JapaneseTts")
public class JapaneseTtsPlugin extends Plugin {
    private TextToSpeech tts;
    /** null until the engine has initialised; then whether it can speak Japanese. */
    private Boolean japanese = null;
    private final List<Runnable> waiting = new ArrayList<>();
    private final Map<String, PluginCall> speaking = new ConcurrentHashMap<>();
    private final Map<String, Pending> synthesizing = new ConcurrentHashMap<>();

    private static class Pending {
        final PluginCall call;
        final File file;

        Pending(PluginCall call, File file) {
            this.call = call;
            this.file = file;
        }
    }

    @Override
    public void load() {
        tts = new TextToSpeech(getContext(), status -> {
            boolean ok = false;
            if (status == TextToSpeech.SUCCESS) {
                int r = tts.setLanguage(Locale.JAPAN);
                ok = r != TextToSpeech.LANG_MISSING_DATA && r != TextToSpeech.LANG_NOT_SUPPORTED;
                tts.setOnUtteranceProgressListener(new Listener());
            }
            List<Runnable> run;
            synchronized (waiting) {
                japanese = ok;
                run = new ArrayList<>(waiting);
                waiting.clear();
            }
            for (Runnable r : run) r.run();
        });
    }

    /** Run once the engine has initialised (immediately if it already has). */
    private void whenReady(Runnable r) {
        synchronized (waiting) {
            if (japanese == null) {
                waiting.add(r);
                return;
            }
        }
        r.run();
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        whenReady(() -> {
            JSObject ret = new JSObject();
            ret.put("available", Boolean.TRUE.equals(japanese));
            call.resolve(ret);
        });
    }

    @PluginMethod
    public void speak(PluginCall call) {
        String text = call.getString("text", "");
        float rate = call.getFloat("rate", 1.0f);
        whenReady(() -> {
            if (!Boolean.TRUE.equals(japanese)) {
                call.reject("No Japanese text-to-speech voice is installed.");
                return;
            }
            String id = UUID.randomUUID().toString();
            speaking.put(id, call);
            tts.setSpeechRate(rate);
            if (tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, id) != TextToSpeech.SUCCESS) {
                speaking.remove(id);
                call.reject("Speech failed.");
            }
        });
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        for (PluginCall c : speaking.values()) c.resolve();
        speaking.clear();
        call.resolve();
    }

    /** Record `text` to a WAV file and return it base64-encoded. */
    @PluginMethod
    public void synthesize(PluginCall call) {
        String text = call.getString("text", "");
        float rate = call.getFloat("rate", 1.0f);
        whenReady(() -> {
            if (!Boolean.TRUE.equals(japanese)) {
                call.reject("No Japanese text-to-speech voice is installed.");
                return;
            }
            try {
                String id = UUID.randomUUID().toString();
                File file = File.createTempFile("tts", ".wav", getContext().getCacheDir());
                synthesizing.put(id, new Pending(call, file));
                tts.setSpeechRate(rate);
                if (tts.synthesizeToFile(text, new Bundle(), file, id) != TextToSpeech.SUCCESS) {
                    synthesizing.remove(id);
                    file.delete();
                    call.reject("Recording failed.");
                }
            } catch (IOException e) {
                call.reject("Recording failed.", e);
            }
        });
    }

    private class Listener extends UtteranceProgressListener {
        @Override
        public void onStart(String id) {}

        @Override
        public void onDone(String id) {
            PluginCall s = speaking.remove(id);
            if (s != null) s.resolve();
            Pending p = synthesizing.remove(id);
            if (p != null) {
                try {
                    byte[] bytes = readAll(p.file);
                    JSObject ret = new JSObject();
                    ret.put("data", Base64.encodeToString(bytes, Base64.NO_WRAP));
                    ret.put("mimeType", "audio/wav");
                    p.call.resolve(ret);
                } catch (IOException e) {
                    p.call.reject("Recording failed.", e);
                } finally {
                    p.file.delete();
                }
            }
        }

        @Override
        public void onStop(String id, boolean interrupted) {
            PluginCall s = speaking.remove(id);
            if (s != null) s.resolve();
        }

        @Override
        @Deprecated
        public void onError(String id) {
            fail(id);
        }

        @Override
        public void onError(String id, int errorCode) {
            fail(id);
        }

        private void fail(String id) {
            PluginCall s = speaking.remove(id);
            if (s != null) s.reject("Speech failed.");
            Pending p = synthesizing.remove(id);
            if (p != null) {
                p.file.delete();
                p.call.reject("Recording failed.");
            }
        }
    }

    private static byte[] readAll(File f) throws IOException {
        byte[] out = new byte[(int) f.length()];
        try (FileInputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < out.length) {
                int n = in.read(out, off, out.length - off);
                if (n < 0) break;
                off += n;
            }
        }
        return out;
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            tts.stop();
            tts.shutdown();
        }
    }
}
