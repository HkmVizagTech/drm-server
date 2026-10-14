package org.harekrishnavizag.drm;

import java.util.Locale;

/**
 * Is this audio file the recording of that call? Pure logic, no Android, so it
 * can be unit tested (see src/test).
 *
 * How the phones name their call recordings:
 *   Samsung   Recordings/Call/Call recording Asha Rao_241014_181523.m4a
 *   Xiaomi    MIUI/sound_recorder/call_rec/Asha Rao(9811111101)_20241014181523.mp3
 *   OnePlus   Music/Recordings/Call Recordings/9811111101-2410141815.m4a
 *   Vivo      Recordings/Record/Call/9811111101 2024-10-14 18-15-23.m4a
 * A saved contact appears by name, not number, so the time the file was last
 * written (the moment the call ended) does most of the work, and the folder
 * or name having "call" in it keeps a voice note from being mistaken for one.
 */
final class RecordingMatch {
    /** Below this, a file is not taken as the call's recording. */
    static final int ENOUGH = 7;

    private RecordingMatch() { }

    /**
     * @param path      folder + name, as the phone gives it ("Recordings/Call/x.m4a")
     * @param phone10   the other party's last ten digits
     * @param startMs   when the call started
     * @param endMs     when it ended (start + talk time)
     * @param addedMs   when the file was created, or 0 if unknown
     * @param modifiedMs when it was last written
     */
    static int score(String path, String phone10, long startMs, long endMs, long addedMs, long modifiedMs) {
        String p = path == null ? "" : path.toLowerCase(Locale.ROOT);
        if (p.contains("whatsapp") || p.contains("telegram") || p.contains("voice note") || p.contains("ringtone")
            || p.contains("notification") || p.contains("alarm") || p.contains("/.")) {
            return 0;
        }
        int s = 0;
        if (phone10 != null && phone10.length() == 10) {
            String flat = p.replaceAll("[^0-9]", "");
            if (flat.contains(phone10)) s += 10;
            else if (flat.contains(phone10.substring(3))) s += 6;
        }
        if (p.contains("call")) s += 5;
        if (p.contains("record")) s += 2;

        // Written as the call ended: up to a minute early (some phones close
        // the file a little before the call log stamps the end) and three late.
        if (modifiedMs >= endMs - 60_000 && modifiedMs <= endMs + 180_000) s += 4;
        else if (modifiedMs < startMs - 60_000 || modifiedMs > endMs + 900_000) return 0;
        if (addedMs > 0 && Math.abs(addedMs - startMs) <= 120_000) s += 2;
        return s;
    }

    /** The better of two equally scored files: the one written closer to the end of the call. */
    static boolean closer(long aModified, long bModified, long endMs) {
        return Math.abs(aModified - endMs) < Math.abs(bModified - endMs);
    }
}
