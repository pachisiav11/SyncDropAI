package com.syncdrop.ai;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Receives files from the Android share sheet and lets the web layer read them
 * without copying them anywhere first.
 *
 * A share hands us a content:// URI, not a path, and the grant on it lasts only
 * as long as this task. Copying the file into our own storage would make it
 * easier to read at leisure, but it would also mean a 2 GB video is written to
 * disk a second time before a single byte is sent. So the URI stays where it is
 * and this plugin streams it on demand.
 *
 * Reads are sequential in practice, so the open stream is kept between calls and
 * reopened only when the caller seeks backwards, which is what a resumed
 * transfer does. Chunks cross the bridge as base64, a third larger than the raw
 * bytes, so the web layer asks for large slices and cuts them up itself.
 */
@CapacitorPlugin(name = "ShareTarget")
public class ShareTargetPlugin extends Plugin {

    private static class Shared {
        final String id;
        final Uri uri;
        final String name;
        final String mime;
        final long size;

        Shared(String id, Uri uri, String name, String mime, long size) {
            this.id = id;
            this.uri = uri;
            this.name = name;
            this.mime = mime;
            this.size = size;
        }

        JSObject toJs() {
            JSObject out = new JSObject();
            out.put("id", id);
            out.put("name", name);
            out.put("mime", mime);
            out.put("size", size);
            return out;
        }
    }

    private static class Reader {
        InputStream stream;
        long position;
    }

    private final Map<String, Shared> pending = new LinkedHashMap<>();
    private final Map<String, Reader> readers = new LinkedHashMap<>();
    private final AtomicLong counter = new AtomicLong();

    @Override
    public void load() {
        absorb(getActivity().getIntent());
    }

    /**
     * launchMode is singleTask, so a second share while we are already running
     * arrives here rather than starting another copy of the activity.
     */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        int before = pending.size();
        absorb(intent);
        if (pending.size() > before) {
            notifyListeners("shareReceived", new JSObject().put("count", pending.size()), true);
        }
    }

    private void absorb(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (action == null) return;

        List<Uri> uris = new ArrayList<>();
        if (Intent.ACTION_SEND.equals(action)) {
            Uri single = intent.getParcelableExtra(Intent.EXTRA_STREAM);
            if (single != null) uris.add(single);
        } else if (Intent.ACTION_SEND_MULTIPLE.equals(action)) {
            ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);
            if (many != null) uris.addAll(many);
        } else {
            return;
        }

        for (Uri uri : uris) {
            if (uri == null) continue;
            String id = "s" + counter.incrementAndGet();
            pending.put(id, describe(id, uri));
        }
        // Consumed. Without this, a rotation or a resume replays the same share.
        intent.setAction(null);
        intent.removeExtra(Intent.EXTRA_STREAM);
    }

    private Shared describe(String id, Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        String name = uri.getLastPathSegment();
        long size = -1;

        try (Cursor cursor = resolver.query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                int sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE);
                if (nameIndex >= 0 && !cursor.isNull(nameIndex)) name = cursor.getString(nameIndex);
                if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex);
            }
        } catch (Exception ignored) {
            // A provider that refuses to be queried still streams, and the size
            // falls back to counting bytes below.
        }

        if (size < 0) size = measure(uri);
        String mime = resolver.getType(uri);
        if (mime == null) mime = "application/octet-stream";
        if (name == null || name.isEmpty()) name = "shared-file";
        return new Shared(id, uri, name, mime, Math.max(size, 0));
    }

    private long measure(Uri uri) {
        try (InputStream stream = getContext().getContentResolver().openInputStream(uri)) {
            if (stream == null) return 0;
            byte[] scratch = new byte[64 * 1024];
            long total = 0;
            int read;
            while ((read = stream.read(scratch)) != -1) total += read;
            return total;
        } catch (Exception error) {
            return 0;
        }
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSArray files = new JSArray();
        for (Shared shared : pending.values()) files.put(shared.toJs());
        JSObject result = new JSObject();
        result.put("files", files);
        call.resolve(result);
    }

    @PluginMethod
    public void read(PluginCall call) {
        String id = call.getString("id");
        Shared shared = id == null ? null : pending.get(id);
        if (shared == null) {
            call.reject("That shared file is no longer available");
            return;
        }

        long offset = call.getLong("offset", 0L);
        int length = call.getInt("length", 4 * 1024 * 1024);
        if (length <= 0) {
            call.reject("Read length must be positive");
            return;
        }

        try {
            Reader reader = readers.get(id);
            if (reader == null || reader.position > offset) {
                if (reader != null) closeQuietly(reader.stream);
                reader = new Reader();
                reader.stream = getContext().getContentResolver().openInputStream(shared.uri);
                reader.position = 0;
                readers.put(id, reader);
            }
            if (reader.stream == null) {
                call.reject("Could not open the shared file");
                return;
            }
            while (reader.position < offset) {
                long skipped = reader.stream.skip(offset - reader.position);
                if (skipped <= 0) break;
                reader.position += skipped;
            }

            byte[] buffer = new byte[length];
            int filled = 0;
            while (filled < length) {
                int read = reader.stream.read(buffer, filled, length - filled);
                if (read == -1) break;
                filled += read;
            }
            reader.position += filled;

            JSObject result = new JSObject();
            result.put("data", Base64.encodeToString(buffer, 0, filled, Base64.NO_WRAP));
            result.put("length", filled);
            call.resolve(result);
        } catch (IOException error) {
            call.reject("Could not read the shared file: " + error.getMessage());
        }
    }

    @PluginMethod
    public void release(PluginCall call) {
        String id = call.getString("id");
        if (id != null) {
            Reader reader = readers.remove(id);
            if (reader != null) closeQuietly(reader.stream);
            pending.remove(id);
        }
        call.resolve();
    }

    private void closeQuietly(InputStream stream) {
        try {
            if (stream != null) stream.close();
        } catch (IOException ignored) {
        }
    }
}
