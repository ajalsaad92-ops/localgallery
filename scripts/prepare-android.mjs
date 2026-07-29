#!/usr/bin/env node
// One-command Android setup for Localphotos Pro.
// Adds the android platform if missing, builds web, syncs Capacitor, and
// patches AndroidManifest.xml with every permission the app needs.
// Run: npm run android
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const run = (cmd) => {
  console.log(`\n▶ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
};

const ANDROID_DIR = resolve("android");
const APP_ID = "app.lovable.c24377afd98c4f369655506b4b645da8";
const PACKAGE_DIR = APP_ID.replaceAll(".", "/");

const writeIfChanged = (path, content) => {
  mkdirSync(resolve(path, ".."), { recursive: true });
  if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
    writeFileSync(path, content);
    return true;
  }
  return false;
};

if (!existsSync(ANDROID_DIR)) {
  console.log("📱 android/ folder not found — adding platform...");
  run("npx cap add android");
} else {
  console.log("📱 android/ folder exists — reusing it.");
}

console.log("\n🛠  Building web bundle...");
run("npm run build");

console.log("\n🔄 Syncing Capacitor plugins...");
run("npx cap sync android");

console.log("\n🎨 Generating launcher icon + splash from resources/...");
try {
  run("npx capacitor-assets generate --android");
} catch {
  console.warn("⚠️  capacitor-assets failed — keeping default icons.");
}

// ---- Patch AndroidManifest.xml ---------------------------------------------
const manifestPath = resolve("android/app/src/main/AndroidManifest.xml");
if (!existsSync(manifestPath)) {
  console.error(`❌ Cannot find ${manifestPath}`);
  process.exit(1);
}

const PERMS = [
  '<uses-permission android:name="android.permission.CAMERA"/>',
  '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>',
  '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO"/>',
  '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED"/>',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>',
  '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29"/>',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>',
  '<uses-permission android:name="android.permission.ACCESS_FINE_LOCATION"/>',
  '<uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>',
  '<uses-permission android:name="android.permission.INTERNET"/>',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>',
  '<uses-permission android:name="android.permission.VIBRATE"/>',
  '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>',
  '<uses-permission android:name="android.permission.WAKE_LOCK"/>',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>',
  '<uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC"/>',
  '<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES"/>',
  '<uses-permission android:name="android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS"/>',

];


let xml = readFileSync(manifestPath, "utf8");
let added = 0;
const missing = PERMS.filter((p) => {
  const name = p.match(/android:name="([^"]+)"/)?.[1];
  return name && !xml.includes(`android:name="${name}"`);
});

if (missing.length) {
  const block = missing.join("\n    ");
  xml = xml.replace(/<application\b/, `${block}\n\n    <application`);
  added = missing.length;
}

const providerBlock = `
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="\${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>`;

if (!xml.includes("android.support.FILE_PROVIDER_PATHS")) {
  xml = xml.replace(/\s*<\/application>/, `${providerBlock}\n    </application>`);
  added++;
}

const serviceBlock = `
        <service
            android:name=".SyncForegroundService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />`;

if (!xml.includes(".SyncForegroundService")) {
  xml = xml.replace(/\s*<\/application>/, `${serviceBlock}\n    </application>`);
  added++;
}

writeFileSync(manifestPath, xml);

const filePathsPath = resolve("android/app/src/main/res/xml/file_paths.xml");
writeIfChanged(filePathsPath, `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="cache" path="." />
    <external-files-path name="external_files" path="." />
</paths>
`);

// ---- Native Android bridge: real MediaStore gallery scanner + internal APK installer
const javaDir = resolve(`android/app/src/main/java/${PACKAGE_DIR}`);
const pluginPath = resolve(javaDir, "LocalGalleryMediaPlugin.java");
const mainActivityPath = resolve(javaDir, "MainActivity.java");

writeIfChanged(pluginPath, `package ${APP_ID};

import android.Manifest;
import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.URLUtil;

import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;

@CapacitorPlugin(
    name = "LocalGalleryMedia",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO }, alias = "media13"),
        @Permission(strings = { Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED }, alias = "media14Selected"),
        @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "mediaLegacy")
    }
)
public class LocalGalleryMediaPlugin extends Plugin {
    private BroadcastReceiver commandReceiver;

    @Override
    public void load() {
        super.load();
        commandReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String action = i.getStringExtra("action");
                if (action == null) return;
                JSObject data = new JSObject();
                data.put("action", action);
                notifyListeners("syncCommand", data);
            }
        };
        IntentFilter f = new IntentFilter(SyncForegroundService.BROADCAST_COMMAND);
        if (Build.VERSION.SDK_INT >= 33) {
            getContext().registerReceiver(commandReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(commandReceiver, f);
        }
    }

    @Override
    protected void handleOnDestroy() {
        try { if (commandReceiver != null) getContext().unregisterReceiver(commandReceiver); } catch (Exception ignored) {}
        super.handleOnDestroy();
    }

    private static class AssetRow {
        String id;
        String name;
        String mime;
        long size;
        long date;
        int width;
        int height;
        long duration;
        String kind;
        Uri uri;
    }


    private boolean hasGalleryAccess() {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 33) {
            boolean images = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
            boolean videos = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED;
            boolean selected = true;
            if (Build.VERSION.SDK_INT >= 34) {
                selected = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED;
            }
            return images || videos || selected;
        }
        return ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_GRANTED;
    }

    private JSObject permissionResult() {
        JSObject ret = new JSObject();
        ret.put("media", hasGalleryAccess() ? PermissionState.GRANTED.toString() : PermissionState.PROMPT.toString());
        return ret;
    }

    @PluginMethod
    public void checkGalleryPermissions(PluginCall call) {
        call.resolve(permissionResult());
    }

    @PluginMethod
    public void requestGalleryPermissions(PluginCall call) {
        if (hasGalleryAccess()) {
            call.resolve(permissionResult());
            return;
        }
        if (Build.VERSION.SDK_INT >= 34) {
            requestPermissionForAliases(new String[] { "media13", "media14Selected" }, call, "galleryPermsCallback");
        } else if (Build.VERSION.SDK_INT >= 33) {
            requestPermissionForAlias("media13", call, "galleryPermsCallback");
        } else {
            requestPermissionForAlias("mediaLegacy", call, "galleryPermsCallback");
        }
    }

    @PermissionCallback
    private void galleryPermsCallback(PluginCall call) {
        call.resolve(permissionResult());
    }

    private int getInt(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        if (i < 0 || c.isNull(i)) return 0;
        return c.getInt(i);
    }

    private long getLong(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        if (i < 0 || c.isNull(i)) return 0L;
        return c.getLong(i);
    }

    private String getString(Cursor c, String col) {
        int i = c.getColumnIndex(col);
        if (i < 0 || c.isNull(i)) return "";
        return c.getString(i);
    }

    private void queryImages(ArrayList<AssetRow> rows) {
        String[] projection = new String[] {
            MediaStore.Images.Media._ID,
            MediaStore.Images.Media.DISPLAY_NAME,
            MediaStore.Images.Media.MIME_TYPE,
            MediaStore.Images.Media.SIZE,
            MediaStore.Images.Media.DATE_TAKEN,
            MediaStore.Images.Media.DATE_MODIFIED,
            MediaStore.Images.Media.WIDTH,
            MediaStore.Images.Media.HEIGHT
        };
        Cursor cursor = getContext().getContentResolver().query(
            MediaStore.Images.Media.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            MediaStore.Images.Media.DATE_TAKEN + " DESC"
        );
        if (cursor == null) return;
        try {
            while (cursor.moveToNext()) {
                long mediaId = getLong(cursor, MediaStore.Images.Media._ID);
                long taken = getLong(cursor, MediaStore.Images.Media.DATE_TAKEN);
                long modified = getLong(cursor, MediaStore.Images.Media.DATE_MODIFIED) * 1000L;
                AssetRow row = new AssetRow();
                row.kind = "image";
                row.id = "image-" + mediaId;
                row.name = getString(cursor, MediaStore.Images.Media.DISPLAY_NAME);
                if (row.name.length() == 0) row.name = row.id + ".jpg";
                row.mime = getString(cursor, MediaStore.Images.Media.MIME_TYPE);
                if (row.mime.length() == 0) row.mime = "image/*";
                row.size = getLong(cursor, MediaStore.Images.Media.SIZE);
                row.date = taken > 0 ? taken : modified;
                row.width = getInt(cursor, MediaStore.Images.Media.WIDTH);
                row.height = getInt(cursor, MediaStore.Images.Media.HEIGHT);
                row.duration = 0;
                row.uri = Uri.withAppendedPath(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, String.valueOf(mediaId));
                rows.add(row);
            }
        } finally {
            cursor.close();
        }
    }

    private void queryVideos(ArrayList<AssetRow> rows) {
        String[] projection = new String[] {
            MediaStore.Video.Media._ID,
            MediaStore.Video.Media.DISPLAY_NAME,
            MediaStore.Video.Media.MIME_TYPE,
            MediaStore.Video.Media.SIZE,
            MediaStore.Video.Media.DATE_TAKEN,
            MediaStore.Video.Media.DATE_MODIFIED,
            MediaStore.Video.Media.WIDTH,
            MediaStore.Video.Media.HEIGHT,
            MediaStore.Video.Media.DURATION
        };
        Cursor cursor = getContext().getContentResolver().query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            projection,
            null,
            null,
            MediaStore.Video.Media.DATE_TAKEN + " DESC"
        );
        if (cursor == null) return;
        try {
            while (cursor.moveToNext()) {
                long mediaId = getLong(cursor, MediaStore.Video.Media._ID);
                long taken = getLong(cursor, MediaStore.Video.Media.DATE_TAKEN);
                long modified = getLong(cursor, MediaStore.Video.Media.DATE_MODIFIED) * 1000L;
                AssetRow row = new AssetRow();
                row.kind = "video";
                row.id = "video-" + mediaId;
                row.name = getString(cursor, MediaStore.Video.Media.DISPLAY_NAME);
                if (row.name.length() == 0) row.name = row.id + ".mp4";
                row.mime = getString(cursor, MediaStore.Video.Media.MIME_TYPE);
                if (row.mime.length() == 0) row.mime = "video/*";
                row.size = getLong(cursor, MediaStore.Video.Media.SIZE);
                row.date = taken > 0 ? taken : modified;
                row.width = getInt(cursor, MediaStore.Video.Media.WIDTH);
                row.height = getInt(cursor, MediaStore.Video.Media.HEIGHT);
                row.duration = getLong(cursor, MediaStore.Video.Media.DURATION) / 1000L;
                row.uri = Uri.withAppendedPath(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, String.valueOf(mediaId));
                rows.add(row);
            }
        } finally {
            cursor.close();
        }
    }

    private String toWebPath(Uri uri) {
        String localUrl = getBridge().getLocalUrl();
        String raw = uri.toString().replace("content:/", "");
        return localUrl + Bridge.CAPACITOR_CONTENT_START + raw;
    }

    @PluginMethod
    public void scanGallery(PluginCall call) {
        if (!hasGalleryAccess()) {
            call.reject("gallery permission is required");
            return;
        }
        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = Math.max(1, call.getInt("limit", 80));

        ArrayList<AssetRow> rows = new ArrayList<>();
        queryImages(rows);
        queryVideos(rows);
        Collections.sort(rows, new Comparator<AssetRow>() {
            @Override public int compare(AssetRow a, AssetRow b) {
                return Long.compare(b.date, a.date);
            }
        });

        JSArray items = new JSArray();
        int end = Math.min(rows.size(), offset + limit);
        for (int i = offset; i < end; i++) {
            AssetRow row = rows.get(i);
            JSObject obj = new JSObject();
            obj.put("id", row.id);
            obj.put("name", row.name);
            obj.put("mime", row.mime);
            obj.put("size", row.size);
            obj.put("date", row.date > 0 ? row.date : System.currentTimeMillis());
            obj.put("width", row.width);
            obj.put("height", row.height);
            obj.put("duration", row.duration);
            obj.put("kind", row.kind);
            obj.put("webPath", toWebPath(row.uri));
            items.put(obj);
        }

        JSObject ret = new JSObject();
        ret.put("total", rows.size());
        ret.put("items", items);
        call.resolve(ret);
    }

    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url", "");
        if (url.length() == 0) {
            call.reject("Missing APK URL");
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("Allow install unknown apps for LocalGallery Pro, then press update again.");
            return;
        }

        try {
            String fileName = URLUtil.guessFileName(url, null, "application/vnd.android.package-archive");
            if (!fileName.endsWith(".apk")) fileName = "localgallery-update.apk";
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getContext().getCacheDir();
            File apk = new File(dir, fileName);

            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestProperty("Accept", "application/vnd.android.package-archive,*/*");
            conn.connect();
            if (conn.getResponseCode() < 200 || conn.getResponseCode() >= 300) {
                call.reject("APK download failed: HTTP " + conn.getResponseCode());
                return;
            }
            try (InputStream in = conn.getInputStream(); FileOutputStream out = new FileOutputStream(apk)) {
                byte[] buffer = new byte[1024 * 64];
                int read;
                while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);
            } finally {
                conn.disconnect();
            }

            Uri apkUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Install failed: " + e.getMessage(), e);
        }
    }

    @PluginMethod
    public void checkBatteryOptimization(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ignoring", isIgnoringBatteryOptimizations());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryOptimizationExemption(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            if (isIgnoringBatteryOptimizations()) {
                ret.put("ignoring", true);
                call.resolve(ret);
                return;
            }
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            ret.put("ignoring", false);
            ret.put("requested", true);
            call.resolve(ret);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
            } catch (Exception ignored) {}
            ret.put("ignoring", false);
            call.resolve(ret);
        }
    }

    private boolean isIgnoringBatteryOptimizations() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            if (pm == null) return false;
            return pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            return false;
        }
    }



    @PluginMethod
    public void startSyncService(PluginCall call) {
        String title = call.getString("title", "جاري المزامنة");
        String text = call.getString("text", "");
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        svc.setAction("START");
        svc.putExtra("title", title);
        svc.putExtra("text", text);
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }

    @PluginMethod
    public void updateSyncService(PluginCall call) {
        String title = call.getString("title", "جاري المزامنة");
        String text = call.getString("text", "");
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        svc.setAction("UPDATE");
        svc.putExtra("title", title);
        svc.putExtra("text", text);
        svc.putExtra("progress", call.getInt("progress", 0));
        svc.putExtra("max", call.getInt("max", 0));
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }

    @PluginMethod
    public void stopSyncService(PluginCall call) {
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        getContext().stopService(svc);
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }
}
`);

const syncServicePath = resolve(javaDir, "SyncForegroundService.java");
writeIfChanged(syncServicePath, `package ${APP_ID};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

public class SyncForegroundService extends Service {
    private static final String CHANNEL_ID = "sync_channel";
    private static final int NOTIF_ID = 4711;
    public static final String ACTION_PAUSE = "app.lovable.sync.PAUSE";
    public static final String ACTION_RESUME = "app.lovable.sync.RESUME";
    public static final String ACTION_STOP = "app.lovable.sync.STOP";
    public static final String BROADCAST_COMMAND = "app.lovable.sync.COMMAND";

    private boolean paused = false;
    private BroadcastReceiver receiver;
    private android.os.PowerManager.WakeLock wakeLock;
    private android.net.wifi.WifiManager.WifiLock wifiLock;

    @Override
    public void onCreate() {
        super.onCreate();
        // Keep the CPU (and Wi-Fi radio) alive so uploads continue after the
        // screen turns off or the app is swiped into the background.
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "LocalGallery:sync");
                wakeLock.setReferenceCounted(false);
                wakeLock.acquire(6 * 60 * 60 * 1000L);
            }
            android.net.wifi.WifiManager wm =
                (android.net.wifi.WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (wm != null) {
                wifiLock = wm.createWifiLock(android.net.wifi.WifiManager.WIFI_MODE_FULL_HIGH_PERF, "LocalGallery:sync");
                wifiLock.setReferenceCounted(false);
                wifiLock.acquire();
            }
        } catch (Exception ignored) {}
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "المزامنة", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("إشعار مستمر أثناء رفع الصور إلى تليكرام");
            NotificationManager mgr = getSystemService(NotificationManager.class);
            if (mgr != null) mgr.createNotificationChannel(ch);
        }

        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String a = i.getAction();
                if (a == null) return;
                Intent out = new Intent(BROADCAST_COMMAND);
                if (ACTION_PAUSE.equals(a)) { paused = true; out.putExtra("action", "pause"); }
                else if (ACTION_RESUME.equals(a)) { paused = false; out.putExtra("action", "resume"); }
                else if (ACTION_STOP.equals(a)) { out.putExtra("action", "stop"); sendBroadcast(out); stopSelf(); return; }
                else return;
                sendBroadcast(out);
            }
        };
        IntentFilter f = new IntentFilter();
        f.addAction(ACTION_PAUSE);
        f.addAction(ACTION_RESUME);
        f.addAction(ACTION_STOP);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(receiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(receiver, f);
        }
    }

    private PendingIntent actionIntent(String action) {
        Intent i = new Intent(action).setPackage(getPackageName());
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(this, action.hashCode(), i, flags);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if ("STOP".equals(action)) { stopSelf(); return START_NOT_STICKY; }

        String title = intent != null ? intent.getStringExtra("title") : "جاري المزامنة";
        String text = intent != null ? intent.getStringExtra("text") : "";
        int progress = intent != null ? intent.getIntExtra("progress", 0) : 0;
        int max = intent != null ? intent.getIntExtra("max", 0) : 0;

        Intent openIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = openIntent != null
            ? PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : null;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title != null ? title : "جاري المزامنة")
            .setContentText(paused ? "موقوفة مؤقتاً" : (text != null ? text : ""))
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (pi != null) b.setContentIntent(pi);
        if (max > 0) b.setProgress(max, progress, paused);

        if (paused) {
            b.addAction(0, "استئناف", actionIntent(ACTION_RESUME));
        } else {
            b.addAction(0, "إيقاف مؤقت", actionIntent(ACTION_PAUSE));
        }
        b.addAction(0, "إيقاف", actionIntent(ACTION_STOP));

        Notification n = b.build();
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, n, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, n);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        try { if (receiver != null) unregisterReceiver(receiver); } catch (Exception ignored) {}
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }


    @Override
    public IBinder onBind(Intent intent) { return null; }
}
`);


writeIfChanged(mainActivityPath, `package ${APP_ID};

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalGalleryMediaPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);

// ---- Version stamping (so Android accepts an in-place update) --------------
// Android refuses to install an APK whose versionCode is lower than the
// installed one, and package managers can skip an identical build. Derive a
// monotonic versionCode from the CI run number (or the timestamp locally).
const gradlePath = resolve("android/app/build.gradle");
if (existsSync(gradlePath)) {
  const pkgVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version || "1.0.0";
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER || 0);
  const versionCode = runNumber > 0 ? runNumber + 1000 : Math.floor(Date.now() / 60000) % 2000000000;
  let gradle = readFileSync(gradlePath, "utf8");
  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${pkgVersion}"`);
  writeFileSync(gradlePath, gradle);
  console.log(`\n🔢 versionCode=${versionCode} versionName=${pkgVersion}`);
}

console.log(
  added
    ? `\n✅ Patched AndroidManifest.xml — added ${added} item(s).`
    : `\n✅ AndroidManifest.xml already had every required item.`,
);

console.log("\n✅ Native LocalGalleryMedia plugin is installed for Android builds.");

console.log(
  "\n🎉 Ready! Open Android Studio with:\n" +
    "   npx cap open android\n" +
    "then hit ▶ Run, or Build → Build APK(s).\n",
);
