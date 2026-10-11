# The text in photos

A screenshot is often the whole point of the message it came with: a vendor's email,
an error in a log, a dashboard, a page of a web app. Its caption says
"look at this", or nothing. Without its text a history search has only "[photo]" to
go on, and the fact in the picture cannot be found. So photos are read, on the
server's own CPU, and what they say is searched like the rest of the talk.

## How it fits in

| Piece | File | What it does |
|---|---|---|
| The reader | `context/ocr_service.py` | A small HTTP service (`POST /ocr` with the image's bytes → its lines of text), started by `context/services.sh start ocr` and installed by `context/setup-ocr.sh` into `$XESIOUS_DATA/venvs/ocr`. CPU only, one core, capped like the other services (`OCR_QUOTA`, 25% of a core by default). |
| Client and tidying | `context/ocr.ts` | Sends a photo, keeps what is worth keeping (drops icons read as "•••", stray letters, a chart's axis numbers), and stores it. Also the command that reads a whole history: `bun context/ocr.ts --db <context.db>`. |
| Storage | `context/engine.ts` | `media_text`, one row per photo message ('' when it had no text). The message's keyword entry carries all of it; its stretch carries the first 600 characters, marked `[text in the photo, machine-read: …]`, so summaries, vectors and the recall see it too. Stretch boundaries do not move. |
| Live groups | `bridge.ts` | With `"ocr": { "url": "http://127.0.0.1:8094" }` in `context-engines.json`, a photo posted in a recorded topic is saved to `state/media/<chat>/<id>.<ext>` and read in the background, a few per minute. Retention deletes the file with its message. |
| Claude's tools | `context/mcp.ts` | `read_messages` shows a photo's text (up to 1,500 characters) next to its file, so Claude knows what a screenshot says before deciding to open it. |

An imported archive is read with the command, then its stretches with photo text are
due new summaries: `bun context/summarize.ts --db <archive> --model sonnet` (it only
writes the ones whose text changed). The bridge brings their vectors up to date on its own.

## How the reader was chosen (2026-09-28)

The machine: 4 shared vCPUs, no GPU, and background work capped at a quarter of a core
(the VPS is throttled if a core runs flat out for hours). The photos: about 1,300 in the
imported archive of a team that writes in Persian and English — dashboards and charts,
logs and code, emails and web pages, phone screenshots of chats. About 1.6% of them
carry real Persian text (4 of 250 sampled); the rest is English UI and prose.

The test: 25 photos drawn at random from the archive (plus a known one), and for each
the words someone would search for, chosen by looking at the picture (names, error
strings, numbers, ids) — 180 terms. An engine scores by how many of those terms come out
of it intact. Persian was tested on the three photos with the most Persian text (a
printed paragraph, a phone screenshot of a chat mixing Persian and English, and a poster
in calligraphy). Time is per photo on one core, the model already loaded.

| Engine | English: terms found | English: words found | Persian: terms found | s/photo |
|---|---|---|---|---|
| **RapidOCR, PP-OCRv5 English + Arabic-script (chosen)** | **86.0%** | **93.2%** | **68%** | **3.9** |
| RapidOCR, PP-OCRv5 English only | 86.0% | 93.2% | 20% | 3.8 |
| RapidOCR, PP-OCRv5 Arabic-script only | 83.8% | 92.3% | 60% | 3.4 |
| RapidOCR, PP-OCRv6 small (multilingual) | 86.6% | 93.4% | 20% | 5.0 |
| RapidOCR, PP-OCRv6 medium | 89.9% | 94.5% | — | 20.9 |
| RapidOCR, PP-OCRv6 tiny | 79.9% | 90.4% | 24% | 1.3 |
| Tesseract 5.5 (eng+fas), dark images inverted, upscaled 2× | 77.7% | 82.5% | 44% | 1.3 |
| Tesseract 5.5 (eng+fas) as is | 49.2% | 58.5% | — | 1.0 |
| EasyOCR 1.7 (fa+en) | — | — | — | 51–136 |

- **PaddleOCR's PP-OCRv5 models, run on ONNX Runtime through RapidOCR**, read these
  screenshots best for their cost. PaddleOCR itself runs the same models; RapidOCR is
  the lighter way to run them (no Paddle framework).
- **PP-OCRv6 does not read Persian** (as packaged by RapidOCR): it read only the Latin
  parts of the Persian test images. v6 *medium* is the most accurate on English, but at
  five times the time: 7 hours of one core for this archive, 30 at the cap.
- **Tesseract** needs its images prepared (it reads light text on dark backgrounds
  badly: 0 of 8 terms on some dashboards) and still trails by 8 points.
- **EasyOCR** took a minute or two per photo on one core: days for the archive.
- **Vision-language models** (Florence-2, Qwen2.5-VL, …) were not tried: minutes per
  image on this CPU, and a caption is not what a search needs; the words are.

**One reader, two models.** Lines are found once (PP-OCRv5 detection, and turned upright
when sideways, as a chart's axis label is) and read by the English model. A line it
cannot read — Persian comes back blank, or as a few Latin words where a whole line of
text is — is read again by the Arabic-script model. The two see different halves of a
mixed line ("جلسه با team B فردا"): the Arabic-script model keeps the Persian and
drops the Latin words, the English model the reverse, so such a line keeps both. On an
English screenshot only a handful of lines (icons) get the second reading, so it costs
next to nothing; on a Persian one it reads the Persian.

Calligraphy (posters, graphics) is read by nothing tried. Some UI chrome is read along with
the content ("Add layer", "Refresh"); it is harmless to search, since it is in every
dashboard and so weighs little.

## What it changed

On the question that prompted this work — about a message whose substance was only in
a screenshot — the right message went from outside the top 30 to first for most of the
searches made for it, once its photo was read. On 16 questions written about what
screenshots show, the right conversation was in the top 5 for about half of them
before, and for 81–88% after. `context/fusion-eval.ts` measures the search as
a whole, with question sets kept outside this repository, beside the history they quote.
