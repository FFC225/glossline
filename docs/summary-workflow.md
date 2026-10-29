# Meeting summaries: one AI writes, another AI checks, a script decides

[中文](summary-workflow.zh-TW.md)

Glossline only does the live captions and the recording. This document describes how we turn the captions into a summary after the meeting.
**It describes the method, not the code.** Our own scripts are tied to a private setup. You can rebuild the method with your own tools by following the steps below.
A general step-by-step guide is in [`skills/meeting-summary/SKILL.md`](../skills/meeting-summary/SKILL.md).

## 1. Why not let one AI write it

When one AI writes a summary alone, it does not tell you what it left out. The result reads well and looks complete, and you cannot see which items are missing.
It also turns "someone suggested" into "it was decided", and it "corrects" rare names in the captions to a spelling it knows better.
None of this produces an error message.

So we split the work between three roles: the writer AI, the reviewer AI, and a script. Each step does one thing, and at the end the script checks that the rules were followed:

| Step | Who | What |
|---|---|---|
| 1 | Writer AI (we use Claude Code) | Reads the whole transcript and writes the summary in a fixed format. Every statement gets the caption time it comes from. |
| 2 | Script | Checks that every time in the summary exists in the transcript and that all sections are there. |
| 3 | Reviewer AI (we use Grok for the checked summary and Gemini for the short one; any other provider works) | Gets the summary and the full transcript. Looks only for overstatements, wrong numbers, missing items, and doubtful things stated as fact. |
| 4 | Writer AI | Checks every review point against the transcript. Correct points are fixed. A rejected or partly accepted point must quote the caption line and time it is based on. |
| 5 | Script | Produces the final files only if all checks pass. If a check fails, there is no output and no way around it. |

Optional step 6, listening back, is in section 4.

## 2. What we measured

All numbers come from our own tests. **The sample is small**: 6 company meetings.
Everything was measured on machine captions that no person had listened back to. Use the numbers for direction, not as exact accuracy.

**1. Another AI writing alone missed 43%.**
For 5 of the meetings, we let another AI (a Gemini model) write the summary alone, and compared its decisions, action items and numbers with a more complete reference version (made by a different process, with errors of its own):

| Items | Same | Written differently | Missing |
|---|---|---|---|
| 162 | 55 (34%) | 37 (23%) | 70 (43%) |

Most missing items were numbers and action items. ⚠ We think it mostly wrote too briefly, and the items were in the captions. We did not check this item by item.

**2. With Claude as the writer, the same meeting had 2 missing items.**
Same meeting, same transcript, same comparison questions (tested on this one meeting only):

| Decisions, action items and numbers (25) | Other AI | Claude |
|---|---|---|
| Same | 5 | 15 |
| Written differently | 2 | 8 |
| Missing | 18 | 2 |
| Of the 16 numbers, missing | 13 | 0 |

**3. The reviewer finds what the writer cannot see.**
Reviewing Claude's summary, the reviewer quoted the transcript 61 times, and all quotes matched. Its main finding: **suggestions written as decisions.**
It also found a wrong calculation, a contradiction in dates, a number one person announced for someone else, and a few missing project updates.
This is why "decisions" has two parts in our format: "settled in the captions" and "only suggested".

**4. The AI misquoted, but did not invent.**
The other AI got 7 quotes wrong. All of them were times off by 1 to 6 seconds or a few missing words. **None was made up.**
But it **corrected a name from general knowledge**: a rare brand name in the captions became the common industry spelling, and went into a decision that way.
So the rule is: copy the caption as it is. If you think it was misheard, mark it with ⚠ separately. Never fix it silently.

**5. Some errors cannot be found by reading.**
In one meeting, a separate after-the-meeting transcription process flagged a price increase percentage as doubtful. Neither AI that only read the text questioned it.
We think the reason is that the number reads naturally, and nothing in the text points to a problem.
Whether the number is right is still open. Machine listening cannot confirm it either (three rounds matched the caption, but an earlier round heard a different number). Only a person listening to the recording can decide.
This is why every number is marked "not listened back".

## 3. Confidence and no invention: five hard rules

| Rule | Can a script check it? |
|---|---|
| Every statement has a caption time; the script looks it up and blocks the output if it is not found | ✅ Yes |
| Decisions are split into "settled in the captions" and "only suggested" | ✅ Yes, that the split exists |
| Every number is marked "not listened back, the recording decides" | ✅ Yes |
| Every review point gets an answer; a rejection or partial accept quotes the caption time and text | ✅ Yes, that every point is answered |
| Whether the answer is right | ❌ **No.** The writer must really go back to the transcript. |

The last row is the limit of the whole method. The script can confirm that every point was answered. It cannot confirm that the answers are correct. We say this openly.

The summary has two more fixed sections:

- **Names and spellings**: every person, brand and part number is marked 🟡 (one spelling is more likely) or 🔴 (open). With only one transcript as source, nothing can reach 🟢.
- **Doubtful points + "please listen to these seconds"**: everything the writer or the reviewer found doubtful goes into one table, with the caption time and what to listen for. Anything that is only said in the chat is lost later.

The summary always starts with a warning: it is based only on machine captions, nobody listened back, and the captions can only tell "computer audio" from "microphone", so who said what is inferred.
The warning travels with the file. Files get forwarded, and the reader never sees the original chat.

## 4. Listening back and traffic lights (optional, needs the recording)

Captions mishear numbers, and the wrong number often still reads fine. So we added a step: an AI that can hear audio listens to each part of the "please listen" table three times, and the result orders which parts a person should listen to first.

1. **Merge the two tracks into one audio file.** The length must equal the original. If it does not, silence was cut and the timeline is off, so the file is not delivered.
2. **Align the clocks.** Caption times are the computer clock; the recording counts seconds from its start. Pick one clear sentence from the beginning, middle and end, plus one from the microphone track. The AI listens to those seconds. Only when all of them match are the clocks aligned. If one does not match, first look at what the AI actually heard: usually the chosen sentence was a bad pick (for example, its first words were cut off), so pick another and run it again.
3. **Cut and listen.** Cut a short clip around each doubtful point. 5 clips per batch, 3 rounds. We tried 15 clips per batch and it failed halfway; with 5 per batch, 4 of 45 batches had to be rerun and 1 was given up.
4. **A script sets the lights** (it compares numbers only; a script decides, not an AI):

| Light | Meaning | Rule |
|---|---|---|
| 🔴 | Listen first | The three rounds disagree about the numbers in the caption, or a round is missing |
| 🟡 | Listen | The three rounds agree but did not all hear the caption's numbers, or there is no number to compare (all names are here) |
| ⚪ | More likely right, nobody listened | The three rounds agree, heard all the caption's numbers, and the number to check is in that part of the caption |

Only numbers that appear in the caption are compared. Different ways of writing the same number ("three" and "3") do not count as disagreement; otherwise every clip would turn red.
| 🟢 | A person listened | **Only from a person's own answer.** No number of machine rounds gives green. |

⚠ **Three rounds agreeing does not mean right.** In one test, the caption said one month and two machine rounds both heard the month before. That is why "agree, but differ from the caption" is 🟡, not ⚪.
Our test with 75 clips: 45 agreed, 25 disagreed, 5 had a missing round.

5. **Hand it to a person.** A listening page shows each question with a short clip and a few choices. The person's answers are pasted back and saved word for word.
6. **Only a person's answer can become ✅.** When the summary says "✅ listened (q3)", the script looks for a real answer to question 3 in the saved answers. "Could not hear it" does not count. If there is no answer, there is no output. This stops the writer AI from changing "not listened back" to ✅ by itself.

In the web version of the summary, clicking a time plays the recording from there (8 seconds earlier, because captions lag behind speech).
The machine listening only sets the order of the lights. It never changes the summary. Never use a number the machine heard to edit the summary.

## 5. Two kinds of output

From one transcript we make two kinds of summary for different readers:

| | Checked summary | Short summary |
|---|---|---|
| For | People who act on the summary and may quote numbers | People who were in the whole meeting and want notes to keep |
| Format | Key points, highlights, details, decisions (two parts), action items, numbers, names, doubtful points, please listen | Per topic: "what was discussed → conclusion", one table "who / what / when", and optionally "worth a second look" (at most 3 items) |
| Times and lights | Time on every statement; optional listening and lights | No times, confidence marks or lights in the text |
| Review | Yes | Yes, but only to fix mistakes; nothing is shown on the page |
| Delivered as | Summary (Markdown), summary web page and the transcript; optional listening page | An editable Word file |

The short summary has its own checks: every topic needs both "discussed" and "conclusion", and no cell in the action table may be empty (write "not stated" if nobody said). Outside the warning at the top, the words "listen back", "confidence", "reliability", "traffic light", "please listen" or any light symbol block the output.
On the first trial of the short summary, the reviewer found 3 problems, and all 3 were right: a rule with two cases merged into one sentence, "try to" written as "every time", and the wrong person named for an action.

## 6. Writing rules (each one learned in a test)

- **Read the whole transcript before writing.** Read long ones in parts, and skip nothing. Do not look at any other summary of the same meeting.
- **Do not turn uncertain words into conclusions.** "May" is not "will". An example number a speaker makes up is not a real number.
- **When several remote people share one track**, write "remote (probably X)". If you are not sure, do not name anyone.
- **Quotes contain the caption text.** Copy English as it is. Do not translate and then put it in quotes.
- **If nobody decided, it goes into "discussed" or "only suggested"**, never into conclusions.
- **"If needed" items do not go into the action table.**
- **Every doubtful point you find goes into the table before delivery.**
- **Never edit the original transcript.** The transcript you deliver is the one from the meeting.

## 7. Where it breaks (things the checks cannot see)

- The captions only know "computer audio" and "microphone". All remote people are mixed together, so who said what is inferred.
- With only one transcript as source, errors that only a second transcript would show stay invisible.
- The Taiwan wording table in the Chinese conversion replaces a few words with computer terms. The captions were right; do not treat these as mishearing.
- When the reviewer returns "zero review points", it usually did not follow the format; it does not mean there were no mistakes. Zero is not a pass, and the script must block it.
- Each of our checks has a test that breaks it on purpose, to prove it really blocks. If you copy this method, do the same: before you trust a green check, prove it can turn red.

## 8. Tools we use

- **Soniox**: live captions and translation during the meeting (that is Glossline itself).
- **Claude Code**: writes the summary and checks each review point against the transcript.
- **A second AI**: reviews. We use Grok for the checked summary and Gemini for the short one. Any provider works, as long as it is not the writer.
- **An AI that can hear audio** (optional): machine listening. We use Gemini.
- **Small scripts**: time lookup, checks, cutting audio, lights, web pages. None of them is hard to write. We do not publish ours because they are tied to a private setup.

⚠ Before you send meeting content to a second or third AI provider, get consent from the people in the meeting, and read that provider's data retention terms.
