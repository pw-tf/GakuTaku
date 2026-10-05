import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.gakutaku',
  appName: 'GakuTaku',
  webDir: 'dist',
  android: {
    // Book/deck files are picked from the device's storage via the system file picker.
    allowMixedContent: false,
  },
};

export default config;
