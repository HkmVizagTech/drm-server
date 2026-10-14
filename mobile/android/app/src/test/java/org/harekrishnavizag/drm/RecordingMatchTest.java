package org.harekrishnavizag.drm;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Picking the right file as a call's recording, by the names the phones really use. */
public class RecordingMatchTest {
    private static final String ASHA = "9811111101";
    private static final long START = 1_760_000_000_000L;
    private static final long END = START + 245_000L;

    private int score(String path, long modified) {
        return RecordingMatch.score(path, ASHA, START, END, 0, modified);
    }

    @Test
    public void samsungRecordingOfASavedContactIsTaken() {
        int s = score("Recordings/Call/Call recording Asha Rao_241014_181523.m4a", END + 2_000);
        assertTrue("score " + s, s >= RecordingMatch.ENOUGH);
    }

    @Test
    public void xiaomiRecordingWithTheNumberScoresHighest() {
        int byNumber = score("MIUI/sound_recorder/call_rec/Asha Rao(9811111101)_20241014181523.mp3", END + 2_000);
        int byTime = score("Recordings/Call/Call recording Asha Rao_241014_181523.m4a", END + 2_000);
        assertTrue(byNumber > byTime);
    }

    @Test
    public void numberWithCountryCodeOrSpacesStillMatches() {
        assertTrue(score("Call/+91 98111 11101_2410141815.amr", END) >= RecordingMatch.ENOUGH);
    }

    @Test
    public void aVoiceNoteAtTheSameMomentIsNotTaken() {
        assertTrue(score("Recordings/Voice Recorder/Voice 001.m4a", END + 1_000) < RecordingMatch.ENOUGH);
        assertEquals(0, score("Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Voice Notes/PTT-20241014.opus", END));
    }

    @Test
    public void aRecordingOfAnEarlierCallIsNotTaken() {
        assertEquals(0, score("Recordings/Call/Call recording Bala_241014_170000.m4a", START - 3_600_000));
    }

    @Test
    public void aRecordingOfALaterCallIsNotTaken() {
        assertEquals(0, score("Recordings/Call/Call recording Chitra_241014_190000.m4a", END + 3_600_000));
    }

    @Test
    public void theFileWrittenCloserToTheEndWins() {
        assertTrue(RecordingMatch.closer(END + 1_000, END + 90_000, END));
    }
}
