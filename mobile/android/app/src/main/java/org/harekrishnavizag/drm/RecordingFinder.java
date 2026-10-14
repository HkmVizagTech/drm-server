package org.harekrishnavizag.drm;

import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Finds the recording the phone's own dialer made of a call.
 *
 * Android does not let apps record calls themselves (since Android 10), but
 * most Samsung, Xiaomi, Vivo, Oppo, Realme and OnePlus dialers record every
 * call into a folder on the phone when "auto record" is on. This looks there,
 * two ways: through the phone's media index (needs "Music and audio"), and by
 * walking the known folders (needs "All files", for phones whose recordings
 * are not in the media index). Phones using the Google Phone app keep their
 * recordings private to that app, and nothing can be found on them.
 */
final class RecordingFinder {
    static final class Found {
        Uri uri;
        File file;
        String name;
        String folder;
        long size;
        long modifiedMs;
        String type;
        int score;

        InputStream open(Context ctx) throws Exception {
            return file != null ? new FileInputStream(file) : ctx.getContentResolver().openInputStream(uri);
        }

        String id() {
            return file != null ? file.getAbsolutePath() : String.valueOf(uri);
        }
    }

    /** Folders, under the phone's storage, where the common dialers keep call recordings. */
    static final String[] FOLDERS = {
        "Recordings/Call", "Recordings/Call recordings", "Recordings/Call Recordings", "Recordings/Record/Call",
        "Recordings", "Call", "Call recordings", "CallRecordings", "Call Recordings",
        "MIUI/sound_recorder/call_rec", "MIUI/sound_recorder", "Music/Recordings/Call Recordings",
        "Music/Recordings", "Music/Call Recordings", "Record/Call", "Record/PhoneRecord", "Record",
        "Sounds/CallRecord", "Sounds", "PhoneRecord", "Recorder/call", "Recorder", "Voice Recorder",
    };

    private static final String[] AUDIO_EXT = { ".m4a", ".mp3", ".amr", ".aac", ".3gp", ".ogg", ".opus", ".wav", ".awb", ".mp4" };

    private RecordingFinder() { }

    static boolean allFiles() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.R ? Environment.isExternalStorageManager() : true;
    }

    /** The recording of one call, or null. Files already sent for another call are skipped. */
    static Found find(Context ctx, String phone10, long startMs, long endMs, java.util.Set<String> used) {
        List<Found> all = new ArrayList<>();
        long from = startMs - 120_000;
        long to = endMs + 900_000;
        try {
            all.addAll(fromMediaStore(ctx, from, to));
        } catch (Exception ignored) {
            // No permission, or a media index that will not answer. The folder walk may still find it.
        }
        if (allFiles()) all.addAll(fromFolders(from, to));

        Found best = null;
        for (Found f : all) {
            if (used != null && used.contains(f.id())) continue;
            String path = (f.folder == null ? "" : f.folder + "/") + f.name;
            f.score = RecordingMatch.score(path, phone10, startMs, endMs, 0, f.modifiedMs);
            if (f.score < RecordingMatch.ENOUGH || f.size < 1024) continue;
            if (best == null || f.score > best.score
                || (f.score == best.score && RecordingMatch.closer(f.modifiedMs, best.modifiedMs, endMs))) {
                best = f;
            }
        }
        return best;
    }

    /** The newest call recording of the last week - the setup screen's "can the app see recordings?" check. */
    static Found latest(Context ctx) {
        long now = System.currentTimeMillis();
        List<Found> all = new ArrayList<>();
        try {
            all.addAll(fromMediaStore(ctx, now - 7L * 86_400_000L, now));
        } catch (Exception ignored) { }
        if (allFiles()) all.addAll(fromFolders(now - 7L * 86_400_000L, now));
        Found best = null;
        for (Found f : all) {
            String path = ((f.folder == null ? "" : f.folder + "/") + f.name).toLowerCase(Locale.ROOT);
            if (!path.contains("call") || path.contains("whatsapp")) continue;
            if (best == null || f.modifiedMs > best.modifiedMs) best = f;
        }
        return best;
    }

    private static List<Found> fromMediaStore(Context ctx, long fromMs, long toMs) {
        List<Found> out = new ArrayList<>();
        ContentResolver cr = ctx.getContentResolver();
        boolean files = allFiles();
        Uri uri = files ? MediaStore.Files.getContentUri("external") : MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
        boolean q = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q;
        String[] cols = q
            ? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.RELATIVE_PATH }
            : new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.SIZE,
                MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.DATA };
        String sel = MediaStore.MediaColumns.DATE_MODIFIED + " >= ? AND " + MediaStore.MediaColumns.DATE_MODIFIED + " <= ?";
        String[] args = { String.valueOf(fromMs / 1000), String.valueOf(toMs / 1000) };
        try (Cursor c = cr.query(uri, cols, sel, args, MediaStore.MediaColumns.DATE_MODIFIED + " DESC")) {
            if (c == null) return out;
            while (c.moveToNext()) {
                String name = c.getString(1);
                String type = c.getString(4);
                if (name == null) continue;
                if (!isAudio(name, type)) continue;
                Found f = new Found();
                f.uri = ContentUris.withAppendedId(uri, c.getLong(0));
                f.name = name;
                f.size = c.getLong(2);
                f.modifiedMs = c.getLong(3) * 1000L;
                f.type = type;
                String where = c.getString(5);
                if (q) {
                    f.folder = where == null ? "" : where.replaceAll("/+$", "");
                } else if (where != null) {
                    File parent = new File(where).getParentFile();
                    f.folder = parent == null ? "" : relative(parent);
                }
                out.add(f);
            }
        }
        return out;
    }

    private static List<Found> fromFolders(long fromMs, long toMs) {
        List<Found> out = new ArrayList<>();
        File root = Environment.getExternalStorageDirectory();
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (String rel : FOLDERS) {
            File dir = new File(root, rel);
            walk(dir, 0, fromMs, toMs, out, seen);
        }
        return out;
    }

    private static void walk(File dir, int depth, long fromMs, long toMs, List<Found> out, java.util.Set<String> seen) {
        if (depth > 2 || !dir.isDirectory()) return;
        File[] list = dir.listFiles();
        if (list == null) return;
        for (File f : list) {
            if (f.isDirectory()) {
                walk(f, depth + 1, fromMs, toMs, out, seen);
                continue;
            }
            long m = f.lastModified();
            if (m < fromMs || m > toMs || !isAudio(f.getName(), null)) continue;
            if (!seen.add(f.getAbsolutePath())) continue;
            Found x = new Found();
            x.file = f;
            x.name = f.getName();
            x.folder = relative(f.getParentFile());
            x.size = f.length();
            x.modifiedMs = m;
            x.type = typeOf(f.getName());
            out.add(x);
        }
    }

    private static String relative(File dir) {
        if (dir == null) return "";
        String root = Environment.getExternalStorageDirectory().getAbsolutePath();
        String p = dir.getAbsolutePath();
        return p.startsWith(root) ? p.substring(root.length()).replaceAll("^/+", "") : p;
    }

    static boolean isAudio(String name, String type) {
        if (type != null && type.startsWith("audio/")) return true;
        String n = name.toLowerCase(Locale.ROOT);
        for (String e : AUDIO_EXT) if (n.endsWith(e)) return true;
        return false;
    }

    static String typeOf(String name) {
        String n = name.toLowerCase(Locale.ROOT);
        if (n.endsWith(".m4a") || n.endsWith(".mp4")) return "audio/mp4";
        if (n.endsWith(".mp3")) return "audio/mpeg";
        if (n.endsWith(".amr") || n.endsWith(".awb")) return "audio/amr";
        if (n.endsWith(".aac")) return "audio/aac";
        if (n.endsWith(".3gp")) return "audio/3gpp";
        if (n.endsWith(".ogg") || n.endsWith(".opus")) return "audio/ogg";
        if (n.endsWith(".wav")) return "audio/wav";
        return "application/octet-stream";
    }
}
