---
name: meeting-summary
description: Turn a Glossline meeting transcript into a checked summary. One AI writes, a second AI reviews, the writer checks every review point against the transcript, and the summary is delivered only when all script checks pass. Use when the user wants a meeting summarized or hands over a Glossline transcript.
---

# Meeting summary (general version)

[中文](SKILL.zh-TW.md) | Method and test numbers: [`docs/summary-workflow.md`](../../docs/summary-workflow.md)

This is a procedure for an AI assistant such as Claude Code. It comes without code: you write the checks as small scripts yourself, because **a check must be a script, not an AI saying "I checked it"**.

## Input

Glossline saves one Markdown transcript per meeting. Each line looks like this:

```
[14:03:12] 【電腦聲音】We can ship the first batch next Friday.
→ 我們下週五可以出第一批。
```

- `[hh:mm:ss]` is the computer clock, not the position in the recording.
- `【電腦聲音】` ("computer audio") is all remote people mixed together; `【麥克風】` ("microphone") is you.
- Lines starting with `→` are the translation.

## Steps

| # | Who | What |
|---|---|---|
| 1 | Script | Copy the transcript into a work folder, drop the `→` translation lines, and make a version with line numbers. **Never edit the original.** |
| 2 | AI | Read the whole transcript (in parts if it is long, skip nothing) and write `summary.md` from the template below. Every source is a caption time. |
| 3 | Script | Run checks 1–5. Fix anything that fails. |
| 4 | Second AI | Give it the summary and the full numbered transcript. Ask only for: overstatements, wrong numbers, missing items, doubtful things stated as fact. Each point must quote the transcript. |
| 5 | AI | Check every review point against the transcript and write `review-log.md`. Fix the summary where the point is right. |
| 6 | Script + person | (Optional) listening back and traffic lights, see below. |
| 7 | Script | Run all checks. Produce the final files only if all pass. **Never produce them by hand when a check fails.** |

## Summary template

```markdown
# <one-line title>

> ⚠️ This summary is based only on live machine captions. Nobody listened back to check it.
> ⏱️ Times in brackets are the computer clock from the captions, not the minute in the recording.
> 🎙️ The captions only know [computer audio] and [microphone]. Who said what is inferred from context.

## Key points
## Highlights            ← 5–8 items, each with a time
## Details               ← one subsection per topic, each item with a time
## Decisions
**Settled in the captions**
**Only suggested (nobody was heard deciding)**
## Action items (who / what / by when)
## Numbers (none listened back; the recording decides)
## Names and spellings
| As written | Status | Note |      ← only 🟡 one spelling more likely / 🔴 open
## Doubtful points
## Please listen to these seconds
| # | Caption time | What to listen for |
```

## Review log format

```markdown
# Review log (N review points)

1. [Accepted] <what was changed>
2. [Partly accepted] <which half is right>; source [14:21:03] "caption text"
3. [Rejected] <why>; source [14:10:39] "caption text"
```

- Number 1 to N with no gaps. N is the number of review points. Skip none.
- Every [Rejected] and [Partly accepted] must quote the caption time and text. Without it, the rejection is from memory.

## Checks (write them as a script)

| # | What it checks |
|---|---|
| 1 | `summary.md` exists |
| 2 | All template sections are there; the warning says nobody listened back |
| 3 | Every `[hh:mm:ss]` in the summary exists in the transcript, and there are at least 10 |
| 4 | Decisions are split into "settled" and "only suggested" |
| 5 | The numbers section says "not listened back" |
| 6 | The reviewer really answered, with at least 1 point. **Zero points is not a pass**; usually it did not follow the format |
| 7 | The review log answers every point; rejections and partial accepts quote a caption time |
| 8 | Every "✅ listened (qN)" in the summary has a real answer to question N in the person's saved answers ("could not hear" does not count) |

⚠ The checks can see that every point was answered. **They cannot see whether the answers are right.** That is the writer's job: really go back to the transcript for every point.

Write one test per check that breaks it on purpose, to prove it blocks.

## Writing rules

- Read everything before writing. Do not look at other summaries of the same meeting.
- "May" is not "will". An example number a speaker makes up is not a real number.
- If a caption looks misheard, **copy it as it is and mark it with ⚠**. Never fix it to the spelling you think is right.
- Quotes contain the caption text. Copy English as it is; do not translate and then quote.
- When several remote people share one track, write "remote (probably X)". If unsure, name nobody.
- Every doubtful point you find goes into "Doubtful points" and "Please listen" before delivery.

## Listening back and traffic lights (optional, needs the recording)

1. Merge both tracks into one audio file. If the length differs from the original, do not deliver (silence was cut).
2. Align the clocks: pick one clear sentence each from the beginning, middle and end, plus one from the microphone. An AI that can hear audio listens to those seconds. Only if all match are caption clock and recording aligned. If one does not match, first look at what the AI actually heard; usually the sentence was a bad pick, so choose another and run again.
3. Each part of the "Please listen" table is heard 3 times by the audio AI, at most 5 clips per batch.
4. A script compares the numbers in the caption and sets the light ("three" and "3" do not count as different): 🔴 the rounds disagree or a round is missing; 🟡 the rounds agree but did not all hear the caption's numbers, or there is no number to compare (all names are here); ⚪ the rounds agree, heard all the caption's numbers, and the number to check is in that part of the caption.
5. Make a listening page for a person. Save their answers word for word.
6. Only a person's answer can turn an item into "✅ listened (qN)". Only then is it 🟢.

⛔ Machine listening **only decides what to listen to first**. Never edit the summary with a number the machine heard, and never give 🟢 for it. Three rounds can agree and still be wrong.

## Short summary (variant)

For someone who was in the whole meeting and wants notes: per topic "what was discussed → conclusion", then one table "who / what / when" ("not stated" if nobody said).
Optionally add "worth a second look", at most 3 items.
The short summary does not run checks 2–5 above. It has its own set: the warning says nobody listened back; every topic has "discussed" and "conclusion"; no empty cell in the action table; none of the words below and no light symbols in the text; the reviewer returned at least 1 point; the review log answers every point. It still goes to the reviewer and still needs a review log, but the text has no times, confidence marks, lights or listening list (the checks block those words and the light symbols). Keep the "nobody listened back" warning at the top.

## Do not

- ⛔ Pick the writer AI only after testing it. In our test, another AI writing alone missed 43% of decisions, action items and numbers.
- ⛔ Do not edit the original transcript.
- ⛔ Do not repeat numbers from the summary as confirmed facts; listen back first if you need to quote them.
- ⛔ Get consent from the people in the meeting before you send its content to a second AI provider.
