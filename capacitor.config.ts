import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'app.lovable.c24377afd98c4f369655506b4b645da8',
  appName: 'LocalGallery Pro',
  webDir: 'dist',
  // `server.url` is intentionally omitted so the APK loads the bundled assets
  // from `dist/` instead of a remote preview URL.
  server: {
    androidScheme: 'https',
  },
  android: {
    backgroundColor: '#0b0f17',
    // No pull-to-refresh bounce, no zoom gestures — this is an app, not a page.
    webContentsDebuggingEnabled: false,
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 500,
      launchAutoHide: true,
      backgroundColor: '#0b0f17',
      androidSplashResourceName: 'splash',
      showSpinner: false,
    },
    StatusBar: {
      // Immersive edge-to-edge — the WebView draws behind the status bar.
      overlaysWebView: true,
      style: 'DARK',
      backgroundColor: '#00000000',
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_icon_config_sample',
      iconColor: '#ff5722',
    },
  },
};

export default config;
