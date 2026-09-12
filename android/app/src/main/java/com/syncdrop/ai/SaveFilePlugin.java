package com.syncdrop.ai;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Writes a received file out of the app and into the phone's Downloads folder.
 *
 * The web layer keeps an incoming file in its own private storage until someone
 * asks to keep it. On the desktop that hand-off is a link with a download
 * attribute; in an Android WebView that link does nothing at all, so the Save
 * button in the activity list was there and did nothing. This is the missing
 * half.
 *
 * From Android 10 the public Downloads collection is reached through MediaStore
 * and needs no permission, which is the path nearly every phone takes. Older
 * releases would need WRITE_EXTERNAL_STORAGE and a runtime prompt to reach the
 * same folder, so they get the app's own external Downloads directory instead:
 * visible in a file manager, no permission, and no dialog to explain.
 *
 * Bytes arrive in chunks as base64 rather than in one call. A received video can
 * be gigabytes, and both the bridge and the JavaScript string that crosses it
 * have to hold whatever is handed over.
 */
@CapacitorPlugin(name = "SaveFile")
public class SaveFilePlugin extends Plugin {

    private static class Sink {
        OutputStream stream;
        /** Set only on the MediaStore path, where the row stays pending until the last byte. */
        Uri pending;
        String shown;
    }

    private final Map<String, Sink> sinks = new LinkedHashMap<>();
    private final AtomicLong counter = new AtomicLong();

    @PluginMethod
    public void begin(PluginCall call) {
        String name = call.getString("name");
        if (name == null || name.trim().isEmpty()) name = "file";
        name = sanitize(name);
        String mime = call.getString("mime");
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";

        try {
            Sink sink = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? openViaMediaStore(name, mime)
                : openInAppDownloads(name);

            String token = "sv" + counter.incrementAndGet();
            sinks.put(token, sink);

            JSObject result = new JSObject();
            result.put("token", token);
            result.put("path", sink.shown);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not start saving " + name + ": " + error.getMessage());
        }
    }

    private Sink openViaMediaStore(String name, String mime) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        // Marked pending so nothing tries to open a file that is still arriving.
        // MediaStore also renames around collisions on its own, so there is no
        // uniqueness check here to match the one on the desktop side.
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);

        Uri uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (uri == null) throw new IOException("Downloads refused a new file");

        OutputStream stream = resolver.openOutputStream(uri);
        if (stream == null) {
            resolver.delete(uri, null, null);
            throw new IOException("Downloads gave nothing to write to");
        }

        Sink sink = new Sink();
        sink.stream = stream;
        sink.pending = uri;
        sink.shown = Environment.DIRECTORY_DOWNLOADS + "/" + name;
        return sink;
    }

    private Sink openInAppDownloads(String name) throws IOException {
        File dir = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) throw new IOException("This device has no external storage");
        if (!dir.exists() && !dir.mkdirs()) throw new IOException("Could not create " + dir);

        File target = unique(dir, name);
        Sink sink = new Sink();
        sink.stream = new FileOutputStream(target);
        sink.shown = target.getAbsolutePath();
        return sink;
    }

    @PluginMethod
    public void append(PluginCall call) {
        String token = call.getString("token");
        Sink sink = token == null ? null : sinks.get(token);
        if (sink == null) {
            call.reject("That save is no longer open");
            return;
        }

        String data = call.getString("data");
        if (data == null) {
            call.reject("Nothing to append");
            return;
        }

        try {
            sink.stream.write(Base64.decode(data, Base64.DEFAULT));
            call.resolve();
        } catch (Exception error) {
            discard(token);
            call.reject("Could not write the file: " + error.getMessage());
        }
    }

    @PluginMethod
    public void finish(PluginCall call) {
        String token = call.getString("token");
        Sink sink = token == null ? null : sinks.remove(token);
        if (sink == null) {
            call.reject("That save is no longer open");
            return;
        }

        try {
            sink.stream.flush();
            sink.stream.close();
            if (sink.pending != null) {
                ContentValues done = new ContentValues();
                done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContext().getContentResolver().update(sink.pending, done, null, null);
            }
            JSObject result = new JSObject();
            result.put("path", sink.shown);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Could not finish the file: " + error.getMessage());
        }
    }

    @PluginMethod
    public void abort(PluginCall call) {
        discard(call.getString("token"));
        call.resolve();
    }

    /** Closes the stream and removes the half-written file, whichever way it was opened. */
    private void discard(String token) {
        Sink sink = token == null ? null : sinks.remove(token);
        if (sink == null) return;
        try {
            sink.stream.close();
        } catch (IOException ignored) {
        }
        if (sink.pending != null) {
            try {
                getContext().getContentResolver().delete(sink.pending, null, null);
            } catch (Exception ignored) {
            }
        }
    }

    private static String sanitize(String name) {
        String cleaned = name.replaceAll("[\\\\/:*?\"<>|]", "_").trim();
        if (cleaned.isEmpty() || cleaned.equals(".") || cleaned.equals("..")) cleaned = "file";
        return cleaned.length() > 180 ? cleaned.substring(0, 180) : cleaned;
    }

    private static File unique(File dir, String name) {
        File candidate = new File(dir, name);
        if (!candidate.exists()) return candidate;

        int dot = name.lastIndexOf('.');
        String stem = dot > 0 ? name.substring(0, dot) : name;
        String extension = dot > 0 ? name.substring(dot) : "";
        for (int n = 2; n < 1000; n += 1) {
            candidate = new File(dir, stem + " (" + n + ")" + extension);
            if (!candidate.exists()) return candidate;
        }
        return new File(dir, stem + "-" + System.currentTimeMillis() + extension);
    }
}
