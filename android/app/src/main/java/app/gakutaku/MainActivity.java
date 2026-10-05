package app.gakutaku;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JapaneseTtsPlugin.class);
        registerPlugin(NhkPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
