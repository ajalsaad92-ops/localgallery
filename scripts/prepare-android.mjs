#!/usr/bin/env node
// One-command Android setup.
// Adds the android platform if missing, builds the web bundle, syncs Capacitor
// and injects the native pieces: MediaStore scanner, background sync service
// and the APK self-installer.
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

// CI builds the bundle before calling this script, so don't build it twice.
if (process.env.SKIP_WEB_BUILD === "1") {
  console.log("\n⏭  Skipping web build (already built by CI).");
} else {
  console.log("\n🛠  Building web bundle...");
  run("npm run build");
}

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
  '<uses-permission android:name="android.permission.READ_MEDIA_IMAGES"/>',
  '<uses-permission android:name="android.permission.READ_MEDIA_VIDEO"/>',
  '<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED"/>',
  '<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32"/>',
  '<uses-permission android:name="android.permission.POST_NOTIFICATIONS"/>',
  '<uses-permission android:name="android.permission.INTERNET"/>',
  '<uses-permission android:name="android.permission.ACCESS_NETWORK_STATE"/>',
  '<uses-permission android:name="android.permission.VIBRATE"/>',
  '<uses-permission android:name="android.permission.RECEIVE_BOOT_COMPLETED"/>',
  '<uses-permission android:name="android.permission.ACCESS_WIFI_STATE"/>',
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
  xml = xml.replace(/<application\b/, `${missing.join("\n    ")}\n\n    <application`);
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

// stopWithTask=false keeps the upload service (and the process) alive when the
// user swipes the app out of Recents.
const serviceBlock = `
        <service
            android:name=".SyncForegroundService"
            android:exported="false"
            android:stopWithTask="false"
            android:foregroundServiceType="dataSync" />
        <receiver
            android:name=".BootReceiver"
            android:enabled="true"
            android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
            </intent-filter>
        </receiver>`;

if (!xml.includes(".SyncForegroundService")) {
  xml = xml.replace(/\s*<\/application>/, `${serviceBlock}\n    </application>`);
  added++;
}

writeFileSync(manifestPath, xml);

writeIfChanged(
  resolve("android/app/src/main/res/xml/file_paths.xml"),
  `<?xml version="1.0" encoding="utf-8"?>
<paths xmlns:android="http://schemas.android.com/apk/res/android">
    <cache-path name="cache" path="." />
    <external-files-path name="external_files" path="." />
</paths>
`,
);

// ---- Native bridge ----------------------------------------------------------
const javaDir = resolve(`android/app/src/main/java/${PACKAGE_DIR}`);

writeIfChanged(
  resolve(javaDir, "LocalGalleryMediaPlugin.java"),
  `package ${APP_ID};

import android.Manifest;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
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

@CapacitorPlugin(
    name = "LocalGalleryMedia",
    permissions = {
        @Permission(strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO }, alias = "media13"),
        @Permission(strings = { Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED }, alias = "media14Selected"),
        @Permission(strings = { Manifest.permission.READ_EXTERNAL_STORAGE }, alias = "mediaLegacy")
    }
)
public class LocalGalleryMediaPlugin extends Plugin {
    /** Upper bound for one system delete confirmation. */
    private static final int MAX_DELETE_BATCH = 400;

    private BroadcastReceiver commandReceiver;

    @Override
    public void load() {
        super.load();
        commandReceiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String action = i.getStringExtra("action");
                if (action == null) return;
                // Every heartbeat re-asserts the page's visibility. Doing it
                // only in onPause/onStop was not enough: the framework, a
                // configuration change or Chromium itself can flip the page
                // back to hidden at any point, and from then on the queue
                // crawls at one timer tick a minute.
                if (!"stop".equals(action)) {
                    try { WebKeepAlive.assertVisible(getBridge().getWebView()); } catch (Exception ignored) {}
                }
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

    // ---- permissions --------------------------------------------------------
    private boolean hasGalleryAccess() {
        Context ctx = getContext();
        if (Build.VERSION.SDK_INT >= 33) {
            boolean images = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED;
            boolean videos = ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED;
            boolean selected = false;
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
        if (hasGalleryAccess()) { call.resolve(permissionResult()); return; }
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

    // ---- gallery scan -------------------------------------------------------
    private int getInt(Cursor c, int i) { return (i < 0 || c.isNull(i)) ? 0 : c.getInt(i); }
    private long getLong(Cursor c, int i) { return (i < 0 || c.isNull(i)) ? 0L : c.getLong(i); }
    private String getStr(Cursor c, int i) { return (i < 0 || c.isNull(i)) ? "" : c.getString(i); }

    private String toWebPath(Uri uri) {
        return getBridge().getLocalUrl() + Bridge.CAPACITOR_CONTENT_START
             + uri.toString().replace("content:/", "");
    }

    /**
     * One page of the device gallery.
     *
     * Images and videos both live in MediaStore.Files, so a single query with a
     * real LIMIT/OFFSET returns exactly the requested page. The previous
     * implementation read and sorted the entire gallery for every page, which
     * made a full import quadratic in the number of photos.
     */
    @PluginMethod
    public void scanGallery(PluginCall call) {
        if (!hasGalleryAccess()) { call.reject("gallery permission is required"); return; }

        int offset = Math.max(0, call.getInt("offset", 0));
        int limit = Math.max(1, call.getInt("limit", 200));
        long since = call.getLong("since", 0L) == null ? 0L : call.getLong("since", 0L);

        Uri uri = MediaStore.Files.getContentUri("external");
        String[] projection;
        projection = new String[] {
            MediaStore.Files.FileColumns._ID,
            MediaStore.Files.FileColumns.DISPLAY_NAME,
            MediaStore.Files.FileColumns.MIME_TYPE,
            MediaStore.Files.FileColumns.SIZE,
            MediaStore.Files.FileColumns.DATE_MODIFIED,
            MediaStore.Files.FileColumns.WIDTH,
            MediaStore.Files.FileColumns.HEIGHT,
            MediaStore.Files.FileColumns.MEDIA_TYPE,
            MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME
        };
        // DURATION only exists on MediaStore.Files from API 29 onwards.
        if (Build.VERSION.SDK_INT >= 29) {
            String[] withDuration = new String[projection.length + 1];
            System.arraycopy(projection, 0, withDuration, 0, projection.length);
            withDuration[projection.length] = MediaStore.Files.FileColumns.DURATION;
            projection = withDuration;
        }

        String selection = MediaStore.Files.FileColumns.MEDIA_TYPE + " IN (?,?)";
        String[] args;
        if (since > 0) {
            selection += " AND " + MediaStore.Files.FileColumns.DATE_MODIFIED + " > ?";
            args = new String[] {
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE),
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO),
                String.valueOf(since / 1000L)
            };
        } else {
            args = new String[] {
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_IMAGE),
                String.valueOf(MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO)
            };
        }

        String order = MediaStore.Files.FileColumns.DATE_MODIFIED + " DESC";
        ContentResolver cr = getContext().getContentResolver();
        Cursor cursor;
        if (Build.VERSION.SDK_INT >= 26) {
            Bundle q = new Bundle();
            q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, selection);
            q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
            q.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, order);
            q.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
            q.putInt(ContentResolver.QUERY_ARG_OFFSET, offset);
            cursor = cr.query(uri, projection, q, null);
        } else {
            cursor = cr.query(uri, projection, selection, args,
                order + " LIMIT " + limit + " OFFSET " + offset);
        }

        JSArray items = new JSArray();
        if (cursor != null) {
            try {
                int iId = cursor.getColumnIndex(MediaStore.Files.FileColumns._ID);
                int iName = cursor.getColumnIndex(MediaStore.Files.FileColumns.DISPLAY_NAME);
                int iMime = cursor.getColumnIndex(MediaStore.Files.FileColumns.MIME_TYPE);
                int iSize = cursor.getColumnIndex(MediaStore.Files.FileColumns.SIZE);
                int iMod = cursor.getColumnIndex(MediaStore.Files.FileColumns.DATE_MODIFIED);
                int iW = cursor.getColumnIndex(MediaStore.Files.FileColumns.WIDTH);
                int iH = cursor.getColumnIndex(MediaStore.Files.FileColumns.HEIGHT);
                int iType = cursor.getColumnIndex(MediaStore.Files.FileColumns.MEDIA_TYPE);
                int iBucket = cursor.getColumnIndex(MediaStore.Files.FileColumns.BUCKET_DISPLAY_NAME);
                int iDur = Build.VERSION.SDK_INT >= 29
                    ? cursor.getColumnIndex(MediaStore.Files.FileColumns.DURATION) : -1;

                while (cursor.moveToNext()) {
                    long id = getLong(cursor, iId);
                    boolean isVideo = getInt(cursor, iType) == MediaStore.Files.FileColumns.MEDIA_TYPE_VIDEO;
                    long modifiedMs = getLong(cursor, iMod) * 1000L;

                    String name = getStr(cursor, iName);
                    if (name.length() == 0) name = (isVideo ? "video-" : "image-") + id + (isVideo ? ".mp4" : ".jpg");
                    String mime = getStr(cursor, iMime);
                    if (mime.length() == 0) mime = isVideo ? "video/*" : "image/*";

                    Uri itemUri = Uri.withAppendedPath(uri, String.valueOf(id));

                    JSObject o = new JSObject();
                    o.put("id", (isVideo ? "video-" : "image-") + id);
                    o.put("name", name);
                    o.put("mime", mime);
                    o.put("size", getLong(cursor, iSize));
                    o.put("date", modifiedMs > 0 ? modifiedMs : System.currentTimeMillis());
                    o.put("width", getInt(cursor, iW));
                    o.put("height", getInt(cursor, iH));
                    o.put("duration", isVideo ? getLong(cursor, iDur) / 1000L : 0);
                    o.put("kind", isVideo ? "video" : "image");
                    // The album folder — Camera, WhatsApp Images, Screenshots…
                    o.put("bucket", getStr(cursor, iBucket));
                    o.put("webPath", toWebPath(itemUri));
                    items.put(o);
                }
            } finally {
                cursor.close();
            }
        }

        JSObject ret = new JSObject();
        ret.put("items", items);
        ret.put("count", items.length());
        call.resolve(ret);
    }

    /**
     * A real thumbnail for one gallery item.
     *
     * Rendering the original content:// URI in an <img> decodes a full
     * multi-megapixel bitmap for a ~130px cell — and silently fails outright
     * for videos. MediaStore already keeps small thumbnails, so ask for those.
     */
    @PluginMethod
    public void getThumbnail(PluginCall call) {
        String rawId = call.getString("id", "");
        int px = Math.max(96, Math.min(512, call.getInt("size", 256)));
        if (rawId.length() == 0) { call.reject("missing id"); return; }

        boolean isVideo = rawId.startsWith("video-");
        long id;
        try {
            id = Long.parseLong(rawId.replaceFirst("^(image|video)-", ""));
        } catch (Exception e) { call.reject("bad id"); return; }

        android.graphics.Bitmap bmp = null;
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                Uri uri = Uri.withAppendedPath(
                    MediaStore.Files.getContentUri("external"), String.valueOf(id));
                bmp = getContext().getContentResolver()
                        .loadThumbnail(uri, new android.util.Size(px, px), null);
            } else if (isVideo) {
                bmp = MediaStore.Video.Thumbnails.getThumbnail(
                    getContext().getContentResolver(), id,
                    MediaStore.Video.Thumbnails.MINI_KIND, null);
            } else {
                bmp = MediaStore.Images.Thumbnails.getThumbnail(
                    getContext().getContentResolver(), id,
                    MediaStore.Images.Thumbnails.MINI_KIND, null);
            }
        } catch (Exception ignored) {}

        if (bmp == null) { call.reject("no thumbnail"); return; }

        try {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            bmp.compress(android.graphics.Bitmap.CompressFormat.JPEG, 72, out);
            String b64 = android.util.Base64.encodeToString(out.toByteArray(), android.util.Base64.NO_WRAP);
            JSObject ret = new JSObject();
            ret.put("dataUrl", "data:image/jpeg;base64," + b64);
            ret.put("width", bmp.getWidth());
            ret.put("height", bmp.getHeight());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("encode failed: " + e.getMessage());
        } finally {
            bmp.recycle();
        }
    }

    /** Hand a shareable file:// -> content:// URI to the system share sheet. */
    @PluginMethod
    public void shareItems(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids == null || ids.length() == 0) { call.reject("no ids"); return; }
        try {
            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            boolean anyVideo = false;
            for (int i = 0; i < ids.length(); i++) {
                String raw = ids.getString(i);
                if (raw == null) continue;
                if (raw.startsWith("video-")) anyVideo = true;
                long id = Long.parseLong(raw.replaceFirst("^(image|video)-", ""));
                uris.add(Uri.withAppendedPath(
                    MediaStore.Files.getContentUri("external"), String.valueOf(id)));
            }
            if (uris.isEmpty()) { call.reject("no valid ids"); return; }

            String type = anyVideo ? (uris.size() > 1 ? "*/*" : "video/*") : "image/*";
            Intent intent;
            if (uris.size() == 1) {
                intent = new Intent(Intent.ACTION_SEND);
                intent.putExtra(Intent.EXTRA_STREAM, uris.get(0));
            } else {
                intent = new Intent(Intent.ACTION_SEND_MULTIPLE);
                intent.putParcelableArrayListExtra(Intent.EXTRA_STREAM, uris);
            }
            intent.setType(type);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            Intent chooser = Intent.createChooser(intent, call.getString("title", "مشاركة"));
            chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(chooser);

            JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
        } catch (Exception e) {
            call.reject("share failed: " + e.getMessage());
        }
    }

    /** Ask the OS to delete gallery items (shows the system confirm on R+). */
    @PluginMethod
    public void deleteItems(PluginCall call) {
        JSArray ids = call.getArray("ids");
        if (ids == null || ids.length() == 0) { call.reject("no ids"); return; }
        try {
            java.util.ArrayList<Uri> uris = new java.util.ArrayList<>();
            for (int i = 0; i < ids.length(); i++) {
                String raw = ids.getString(i);
                if (raw == null) continue;
                long id = Long.parseLong(raw.replaceFirst("^(image|video)-", ""));
                uris.add(Uri.withAppendedPath(
                    MediaStore.Files.getContentUri("external"), String.valueOf(id)));
            }
            JSObject ret = new JSObject();
            if (Build.VERSION.SDK_INT >= 30) {
                // Android 11+ requires the OS to own the confirmation. Launch it
                // straight from the Activity — Capacitor's Plugin base class has
                // no IntentSender helper. The result is not awaited here; the JS
                // side reconciles against MediaStore afterwards, so a cancelled
                // dialog simply leaves the items in place.
                //
                // One request per press, and never more than MAX_DELETE_BATCH
                // items: the whole list travels to the system through a Binder
                // transaction, and asking to delete five thousand photos at once
                // threw TransactionTooLarge — which this method used to swallow,
                // so the button looked dead.
                if (uris.size() > MAX_DELETE_BATCH) {
                    uris = new java.util.ArrayList<>(uris.subList(0, MAX_DELETE_BATCH));
                }
                android.app.PendingIntent pi = MediaStore.createDeleteRequest(
                    getContext().getContentResolver(), uris);
                getActivity().startIntentSenderForResult(
                    pi.getIntentSender(), 9911, null, 0, 0, 0);
                ret.put("requested", true);
                ret.put("deleted", uris.size());
                call.resolve(ret);
                return;
            }
            int n = 0;
            for (Uri u : uris) {
                try { n += getContext().getContentResolver().delete(u, null, null); }
                catch (Exception ignored) {}
            }
            ret.put("deleted", n);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("delete failed: " + e.getMessage());
        }
    }

    // ---- self-update --------------------------------------------------------
    @PluginMethod
    public void installApk(PluginCall call) {
        String url = call.getString("url", "");
        if (url.length() == 0) { call.reject("Missing APK URL"); return; }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));
            settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(settings);
            call.reject("فعّل «تثبيت تطبيقات غير معروفة» ثم اضغط تحديث مرة أخرى.");
            return;
        }
        try {
            String fileName = URLUtil.guessFileName(url, null, "application/vnd.android.package-archive");
            if (!fileName.endsWith(".apk")) fileName = "update.apk";
            File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (dir == null) dir = getContext().getCacheDir();
            File apk = new File(dir, fileName);

            HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestProperty("Accept", "application/vnd.android.package-archive,*/*");
            conn.setInstanceFollowRedirects(true);
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

            JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
        } catch (Exception e) {
            call.reject("Install failed: " + e.getMessage(), e);
        }
    }

    // ---- storage ------------------------------------------------------------
    private long sizeOf(java.io.File f) {
        if (f == null || !f.exists()) return 0;
        if (f.isFile()) return f.length();
        java.io.File[] kids = f.listFiles();
        if (kids == null) return 0;
        long total = 0;
        for (java.io.File k : kids) total += sizeOf(k);
        return total;
    }

    private java.io.File dataDir() {
        if (Build.VERSION.SDK_INT >= 24) return getContext().getDataDir();
        java.io.File files = getContext().getFilesDir();
        return files != null ? files.getParentFile() : null;
    }

    /**
     * Where the app's disk footprint actually is. Guesswork about which cache
     * grew is how you end up "fixing" four things and moving nothing.
     */
    @PluginMethod
    public void storageUsage(PluginCall call) {
        JSObject ret = new JSObject();
        java.io.File root = dataDir();
        ret.put("total", sizeOf(root));
        JSObject dirs = new JSObject();
        if (root != null) {
            String[] names = {
                "databases", "app_webview", "cache", "files", "shared_prefs", "code_cache"
            };
            for (String n : names) dirs.put(n, sizeOf(new java.io.File(root, n)));
            // The two that grow on their own: Chromium's blob spill area and
            // its profile (IndexedDB, Cache Storage, Local Storage).
            dirs.put("webview_blobs", sizeOf(new java.io.File(root, "app_webview/blob_storage")));
            dirs.put("webview_profile", sizeOf(new java.io.File(root, "app_webview/Default")));
        }
        java.io.File ext = getContext().getExternalCacheDir();
        dirs.put("external_cache", sizeOf(ext));
        ret.put("dirs", dirs);
        call.resolve(ret);
    }

    /**
     * Clears what is safe to clear while the app runs: the HTTP cache and the
     * cache directories. The WebView profile (IndexedDB) is the app's own data
     * and is never touched here.
     */
    @PluginMethod
    public void clearAppCache(final PluginCall call) {
        final java.io.File root = dataDir();
        final long before = sizeOf(getContext().getCacheDir())
            + sizeOf(getContext().getExternalCacheDir())
            + (root != null ? sizeOf(new java.io.File(root, "code_cache")) : 0);
        getActivity().runOnUiThread(new Runnable() {
            @Override public void run() {
                try {
                    if (getBridge() != null && getBridge().getWebView() != null) {
                        getBridge().getWebView().clearCache(true);
                    }
                } catch (Exception ignored) {}
                try {
                    wipeInside(getContext().getCacheDir());
                    wipeInside(getContext().getExternalCacheDir());
                    if (root != null) wipeInside(new java.io.File(root, "code_cache"));
                } catch (Exception ignored) {}
                long after = sizeOf(getContext().getCacheDir())
                    + sizeOf(getContext().getExternalCacheDir())
                    + (root != null ? sizeOf(new java.io.File(root, "code_cache")) : 0);
                JSObject ret = new JSObject();
                ret.put("freed", Math.max(0, before - after));
                call.resolve(ret);
            }
        });
    }

    private void wipeInside(java.io.File dir) {
        if (dir == null || !dir.isDirectory()) return;
        java.io.File[] kids = dir.listFiles();
        if (kids == null) return;
        for (java.io.File k : kids) deleteTree(k);
    }

    private void deleteTree(java.io.File f) {
        if (f == null) return;
        if (f.isDirectory()) {
            java.io.File[] kids = f.listFiles();
            if (kids != null) for (java.io.File k : kids) deleteTree(k);
        }
        try { f.delete(); } catch (Exception ignored) {}
    }

    // ---- battery ------------------------------------------------------------
    private boolean isIgnoringBatteryOptimizations() {
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
        } catch (Exception e) {
            return false;
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
            if (isIgnoringBatteryOptimizations()) { ret.put("ignoring", true); call.resolve(ret); return; }
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

    // ---- foreground service -------------------------------------------------
    private void send(String action, PluginCall call, boolean withProgress) {
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        svc.setAction(action);
        svc.putExtra("title", call.getString("title", "جارٍ المزامنة"));
        svc.putExtra("text", call.getString("text", ""));
        if (withProgress) {
            svc.putExtra("progress", call.getInt("progress", 0));
            svc.putExtra("max", call.getInt("max", 0));
        }
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }

    @PluginMethod public void startSyncService(PluginCall call) { send("START", call, false); }
    @PluginMethod public void updateSyncService(PluginCall call) { send("UPDATE", call, true); }

    @PluginMethod
    public void stopSyncService(PluginCall call) {
        // Only drops the visible progress notification. When background sync is
        // armed the service stays resident in its idle "watching" state.
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        svc.setAction("IDLE");
        if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
        else getContext().startService(svc);
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }

    @PluginMethod
    public void setBackgroundSync(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        SyncForegroundService.setArmed(getContext(), enabled);
        try {
            if (enabled) WebKeepAlive.assertVisible(getBridge().getWebView());
            else WebKeepAlive.release(getBridge().getWebView());
        } catch (Exception ignored) {}
        Intent svc = new Intent(getContext(), SyncForegroundService.class);
        if (enabled) {
            svc.setAction("IDLE");
            if (Build.VERSION.SDK_INT >= 26) getContext().startForegroundService(svc);
            else getContext().startService(svc);
        } else {
            // stopService is safe whether or not the service is running;
            // startService() on a dead service from the background would throw.
            getContext().stopService(svc);
        }
        JSObject ret = new JSObject(); ret.put("ok", true); call.resolve(ret);
    }
}
`,
);

writeIfChanged(
  resolve(javaDir, "SyncForegroundService.java"),
  `package ${APP_ID};

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.IBinder;

import androidx.core.app.NotificationCompat;

/**
 * Keeps uploads alive while the app is not in the foreground.
 *
 * Android suspends a backgrounded WebView's JS timers, so this service holds a
 * wake lock and broadcasts a "tick" that the plugin forwards into JavaScript —
 * a bridge call is not subject to timer throttling. While "armed" the service
 * stays resident between queues so a newly taken photo is picked up without the
 * user opening the app.
 */
public class SyncForegroundService extends Service {
    private static final String CHANNEL_ID = "sync_channel";
    private static final int NOTIF_ID = 4711;
    private static final String PREFS = "sync_prefs";
    private static final String KEY_ARMED = "armed";
    // Fast while a queue is running, slow while merely watching — an idle
    // 5s heartbeat would wake the WebView all night for nothing.
    private static final long TICK_ACTIVE_MS = 5000L;
    private static final long TICK_IDLE_MS = 30000L;

    public static final String ACTION_PAUSE = "app.lovable.sync.PAUSE";
    public static final String ACTION_RESUME = "app.lovable.sync.RESUME";
    public static final String ACTION_STOP = "app.lovable.sync.STOP";
    public static final String BROADCAST_COMMAND = "app.lovable.sync.COMMAND";

    private boolean paused = false;
    private boolean active = false;
    /** Mirrors the active flag for callers outside the service. */
    private static volatile boolean busy = false;
    private BroadcastReceiver receiver;
    private android.os.PowerManager.WakeLock wakeLock;
    private android.net.wifi.WifiManager.WifiLock wifiLock;
    private android.os.Handler ticker;
    private Runnable tick;

    public static void setArmed(Context ctx, boolean armed) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
           .edit().putBoolean(KEY_ARMED, armed).apply();
    }

    public static boolean isArmed(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                  .getBoolean(KEY_ARMED, false);
    }

    /** True while a queue is being uploaded, armed or not (manual runs count). */
    public static boolean isBusy() {
        return busy;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                wakeLock = pm.newWakeLock(android.os.PowerManager.PARTIAL_WAKE_LOCK, "LocalGallery:sync");
                wakeLock.setReferenceCounted(false);
                // Renewed on every tick — an expired lock is why long queues
                // died overnight with no error anywhere.
                wakeLock.acquire(10 * 60 * 1000L);
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
            ch.setDescription("إشعار مستمر أثناء رفع الصور إلى تيليجرام");
            ch.setShowBadge(false);
            NotificationManager mgr = getSystemService(NotificationManager.class);
            if (mgr != null) mgr.createNotificationChannel(ch);
        }

        receiver = new BroadcastReceiver() {
            @Override public void onReceive(Context c, Intent i) {
                String a = i.getAction();
                if (a == null) return;
                Intent out = new Intent(BROADCAST_COMMAND).setPackage(getPackageName());
                if (ACTION_PAUSE.equals(a)) { paused = true; out.putExtra("action", "pause"); }
                else if (ACTION_RESUME.equals(a)) { paused = false; out.putExtra("action", "resume"); }
                else if (ACTION_STOP.equals(a)) {
                    out.putExtra("action", "stop");
                    sendBroadcast(out);
                    setArmed(getApplicationContext(), false);
                    stopSelf();
                    return;
                } else return;
                sendBroadcast(out);
                notifyNow();
            }
        };

        ticker = new android.os.Handler(android.os.Looper.getMainLooper());
        tick = new Runnable() {
            @Override public void run() {
                try {
                    if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire(10 * 60 * 1000L);
                    if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
                } catch (Exception ignored) {}
                if (!paused) {
                    Intent out = new Intent(BROADCAST_COMMAND).setPackage(getPackageName());
                    out.putExtra("action", "tick");
                    sendBroadcast(out);
                }
                ticker.postDelayed(this, active ? TICK_ACTIVE_MS : TICK_IDLE_MS);
            }
        };
        ticker.postDelayed(tick, 5000);

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

    private String title = "مزامنة الصور";
    private String text = "بانتظار صور جديدة";
    private int progress = 0;
    private int max = 0;

    private Notification build() {
        Intent openIntent = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent pi = openIntent != null
            ? PendingIntent.getActivity(this, 0, openIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
            : null;

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(paused ? "موقوفة مؤقتاً" : text)
            .setSmallIcon(active ? android.R.drawable.stat_sys_upload : android.R.drawable.stat_notify_sync)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setPriority(NotificationCompat.PRIORITY_LOW);
        if (pi != null) b.setContentIntent(pi);
        if (active && max > 0) b.setProgress(max, progress, false);

        if (active) {
            if (paused) b.addAction(0, "استئناف", actionIntent(ACTION_RESUME));
            else b.addAction(0, "إيقاف مؤقت", actionIntent(ACTION_PAUSE));
        }
        b.addAction(0, "إيقاف المزامنة", actionIntent(ACTION_STOP));
        return b.build();
    }

    private void notifyNow() {
        NotificationManager mgr = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (mgr != null) mgr.notify(NOTIF_ID, build());
    }

    private void goForeground() {
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIF_ID, build(), android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        } else {
            startForeground(NOTIF_ID, build());
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;

        // START_STICKY hands back a null intent when Android recreates the
        // service after killing it. Treat that as "keep watching" — falling
        // through to the START branch would claim a queue is running and show
        // a stale progress bar forever.
        if (intent == null) {
            active = false;
            busy = false;
            goForeground();
            if (!isArmed(getApplicationContext())) {
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_STICKY;
        }

        // A service launched with startForegroundService() MUST call
        // startForeground() within a few seconds or Android kills the process
        // with ForegroundServiceDidNotStartInTimeException — even if the very
        // next thing it does is stop itself. So promote first, decide after.
        if ("STOP".equals(action)) {
            active = false;
            busy = false;
            goForeground();
            setArmed(getApplicationContext(), false);
            stopForeground(true);
            stopSelf();
            return START_NOT_STICKY;
        }

        if ("IDLE".equals(action)) {
            active = false;
            busy = false;
            title = "مزامنة الصور";
            text = "بانتظار صور جديدة";
            progress = 0; max = 0;
            goForeground();
            // Nothing running and nothing to watch — no reason to stay alive.
            if (!isArmed(getApplicationContext())) {
                stopForeground(true);
                stopSelf();
                return START_NOT_STICKY;
            }
            return START_STICKY;
        }

        // START / UPDATE — an upload queue is running.
        active = true;
        busy = true;
        if (intent != null) {
            if (intent.getStringExtra("title") != null) title = intent.getStringExtra("title");
            if (intent.getStringExtra("text") != null) text = intent.getStringExtra("text");
            progress = intent.getIntExtra("progress", progress);
            max = intent.getIntExtra("max", max);
        }
        goForeground();
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        busy = false;
        try { if (ticker != null && tick != null) ticker.removeCallbacks(tick); } catch (Exception ignored) {}
        try { if (receiver != null) unregisterReceiver(receiver); } catch (Exception ignored) {}
        try { if (wakeLock != null && wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) {}
        try { if (wifiLock != null && wifiLock.isHeld()) wifiLock.release(); } catch (Exception ignored) {}
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }
}
`,
);

writeIfChanged(
  resolve(javaDir, "BootReceiver.java"),
  `package ${APP_ID};

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/** Brings the sync watcher back after a reboot or an app update. */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (!SyncForegroundService.isArmed(context)) return;
        Intent svc = new Intent(context, SyncForegroundService.class);
        svc.setAction("IDLE");
        try {
            if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(svc);
            else context.startService(svc);
        } catch (Exception ignored) {}
    }
}
`,
);

writeIfChanged(
  resolve(javaDir, "WebKeepAlive.java"),
  `package ${APP_ID};

import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.WebView;

/**
 * Keeps the WebView running while the app is off screen.
 *
 * resumeTimers()/onResume() undo the WebView-level pause, but they are not the
 * whole story: Chromium derives the *page's* visibility from the window's
 * visibility, and once the activity stops, the page counts as hidden. A hidden
 * page has its timers throttled to roughly one tick a minute and its renderer
 * demoted to a first-choice victim for the low-memory killer — which is what
 * made uploads crawl and then die a few minutes after the screen went off,
 * battery exemption or not.
 *
 * dispatchWindowVisibilityChanged(VISIBLE) tells Chromium the page is still
 * visible. Only done while a backup is armed, and undone as soon as it is not.
 */
public final class WebKeepAlive {
    private static final Handler UI = new Handler(Looper.getMainLooper());

    private WebKeepAlive() {}

    /** Assert "still visible" once, on the UI thread. */
    public static void assertVisible(final WebView webView) {
        if (webView == null) return;
        UI.post(new Runnable() {
            @Override public void run() {
                try {
                    webView.resumeTimers();
                    webView.onResume();
                    webView.dispatchWindowVisibilityChanged(View.VISIBLE);
                } catch (Exception ignored) {}
            }
        });
    }

    /**
     * The framework dispatches the real visibility change through the view
     * hierarchy *after* onPause/onStop return, so a single call at that moment
     * is overwritten milliseconds later. Repeat on the message queue.
     */
    public static void assertVisibleSoon(final WebView webView) {
        assertVisible(webView);
        UI.postDelayed(new Runnable() {
            @Override public void run() { assertVisible(webView); }
        }, 300);
        UI.postDelayed(new Runnable() {
            @Override public void run() { assertVisible(webView); }
        }, 1500);
    }

    /** Hand the page's visibility back to the window it actually lives in. */
    public static void release(final WebView webView) {
        if (webView == null) return;
        UI.post(new Runnable() {
            @Override public void run() {
                try {
                    webView.dispatchWindowVisibilityChanged(webView.getWindowVisibility());
                } catch (Exception ignored) {}
            }
        });
    }
}
`,
);

writeIfChanged(
  resolve(javaDir, "MainActivity.java"),
  `package ${APP_ID};

import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {
    /** Guards against a reload loop when the renderer dies immediately. */
    private static int rendererRestarts = 0;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LocalGalleryMediaPlugin.class);
        super.onCreate(savedInstanceState);
        installRendererGuard();
    }

    /**
     * Survive the WebView's renderer being killed.
     *
     * Capacitor's client returns false from onRenderProcessGone unless a
     * listener says otherwise, and false tells the framework to kill the app
     * process — which is what "the app opens and closes again" looks like from
     * the outside, with nothing in the UI to explain it. A phone under memory
     * pressure kills that process first, so this has to be survivable: take
     * the callback, and rebuild the activity instead of dying.
     */
    private void installRendererGuard() {
        try {
            if (bridge == null) return;
            bridge.addWebViewListener(new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                    if (rendererRestarts >= 3) {
                        // Something is wrong that a reload will not fix; let it
                        // go rather than spin forever.
                        return false;
                    }
                    rendererRestarts++;
                    runOnUiThread(new Runnable() {
                        @Override public void run() {
                            try { recreate(); } catch (Exception ignored) {}
                        }
                    });
                    return true;
                }
            });
        } catch (Exception ignored) {}
    }

    // Android suspends the WebView's JS timers once the activity leaves the
    // screen, which would stall uploads mid-queue. The foreground service keeps
    // the process alive, so keep the page awake too — but only while a backup
    // is armed, so an idle app still goes properly to sleep.
    @Override
    public void onPause() {
        super.onPause();
        keepWebViewRunning();
    }

    @Override
    public void onStop() {
        super.onStop();
        keepWebViewRunning();
    }

    private void keepWebViewRunning() {
        try {
            if (bridge == null || bridge.getWebView() == null) return;
            if (SyncForegroundService.isArmed(this) || SyncForegroundService.isBusy()) {
                WebKeepAlive.assertVisibleSoon(bridge.getWebView());
            }
        } catch (Exception ignored) {}
    }
}
`,
);

// ---- Signing + version stamping ---------------------------------------------
const gradlePath = resolve("android/app/build.gradle");
if (existsSync(gradlePath)) {
  let gradle = readFileSync(gradlePath, "utf8");

  // Pin the signing key explicitly.
  //
  // Without this, a debug build is signed with whatever Gradle finds at its
  // default debug-keystore location — and on CI that is NOT the file we place
  // in ~/.android/, so Gradle silently generated a throwaway key on every run.
  // That is why four consecutive releases shipped four different certificates
  // and every in-app update failed with a signature mismatch.
  if (!gradle.includes("signingConfigs.appkey")) {
    const signingBlock = `
    signingConfigs {
        appkey {
            storeFile file("\${rootDir}/../signing/app-signing.keystore")
            storePassword "android"
            keyAlias "androiddebugkey"
            keyPassword "android"
        }
    }
`;
    gradle = gradle.replace(/android\s*\{/, (m) => `${m}\n${signingBlock}`);

    // Apply it to both build types so the APK is identical either way.
    if (/buildTypes\s*\{\s*[\s\S]*?\bdebug\s*\{/.test(gradle)) {
      gradle = gradle.replace(/(\bdebug\s*\{)/, `$1\n            signingConfig signingConfigs.appkey`);
    } else {
      gradle = gradle.replace(
        /buildTypes\s*\{/,
        `buildTypes {\n        debug {\n            signingConfig signingConfigs.appkey\n        }`,
      );
    }
    gradle = gradle.replace(
      /(\brelease\s*\{)/,
      `$1\n            signingConfig signingConfigs.appkey`,
    );
    console.log("🔐 Pinned signingConfig to signing/app-signing.keystore");
  }

  // Android refuses an APK whose versionCode is lower than the installed one.
  const pkgVersion = JSON.parse(readFileSync(resolve("package.json"), "utf8")).version || "1.0.0";
  const runNumber = Number(process.env.GITHUB_RUN_NUMBER || 0);
  // The offset must clear every versionCode ever published, because the run
  // counter restarted at 1 when the project moved repositories. The old repo
  // reached run 53 (versionCode 1053); anything below that is refused by
  // Android as a downgrade even when the signature matches.
  const VERSION_CODE_BASE = 3000;
  const versionCode =
    runNumber > 0 ? runNumber + VERSION_CODE_BASE : Math.floor(Date.now() / 60000) % 2000000000;
  gradle = gradle
    .replace(/versionCode\s+\d+/, `versionCode ${versionCode}`)
    .replace(/versionName\s+"[^"]*"/, `versionName "${pkgVersion}"`);

  writeFileSync(gradlePath, gradle);
  console.log(`🔢 versionCode=${versionCode} versionName=${pkgVersion}`);
}

console.log(
  added
    ? `\n✅ Patched AndroidManifest.xml — added ${added} item(s).`
    : `\n✅ AndroidManifest.xml already had every required item.`,
);
console.log("✅ Native plugin, background service and boot receiver installed.");
console.log("\n🎉 Ready:  npx cap open android\n");
