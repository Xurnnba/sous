# The ears: design notes and measured performance

## What the ears are for

A restaurant produces a stream of small, meaningful sounds that nobody is paid to listen for: the
POS printer spitting out a ticket, a fryer timer, the front-door chime, the landline, a tray of
plates hitting the floor. Each one means a decision for someone who is already busy. The ears turn
that stream into a short list of events with a location and a confidence, so the agent can turn
them into action items at a pace a human can follow.

Design goals, in the order we traded them off: **no false alarms** (a wrong "Dasher at the door"
costs trust), **works across a room on a laptop or phone mic**, **calibrates to this kitchen in
seconds**, **runs on cheap hardware**.

## Architecture

```
mic (laptop / phone / USB)  ──►  browser: AudioWorklet, resample to 16 kHz Int16, 250 ms frames
                                      │  /ws/audio?mic=<id>&location=<kitchen|front|pass>
                                      ▼
                        per-mic EarClassifier (backend/sous/senses/ear/classifier.py)
      ┌───────────────┬──────────────────┬──────────────────────┬─────────────────────┐
      │ noise floor   │ AGC to -20 dBFS  │ spectral gate        │ YAMNet embedding    │
      │ (activity)    │ (level-invariant)│ (room's own noise)   │ 521 scores + 1024-d │
      └───────────────┴──────────────────┴──────────────────────┴─────────────────────┘
                                      ▼
              zero-shot prior (AudioSet → kitchen events)  +  few-shot k-NN over taught prototypes
                                      ▼
                   continuation merge · hold time · burst counter · evidence attached
                                      ▼
                              hearing Event → agent → action item
```

* **Model.** YAMNet (Google, AudioSet, 3.7 M parameters, MobileNet-v1). 7 ms per second of audio on a
  laptop CPU after warm-up; small enough for a phone or a Raspberry Pi 4. We use its 521 class
  scores as a zero-shot prior and its 1024-d embedding for calibration.
* **Multi-mic.** Every device that opens `/ws/audio` is a microphone with an id and a location. A
  laptop at the pass and a phone at the front door are two mics; events carry the location, so
  "Dasher at the door" comes from the front mic and "fryer alarm" from the kitchen mic. All mics
  share one prototype store, so a sound taught at one is recognised at the others.
* **Low-volume sounds.** Three things make faint sounds detectable: the per-room noise floor
  (activity is relative to *this* room, not an absolute level), AGC (every active window is
  normalised before embedding, so distance mostly stops mattering), and the spectral gate (the
  room's own quiet-frame spectrum is subtracted before the few-shot embedding).
* **Calibration without training.** "Teach" records four seconds through the real mic. Each active
  window's embedding becomes a prototype; each is also mixed with the room's recorded noise at
  12, 6 and 0 dB SNR, so one quiet teaching session covers a loud service. The room itself is
  memorised continuously as a `_background` class. Decision is a similarity-weighted 3-nearest-
  neighbour vote; the winner must beat background by a margin. No gradient descent, no GPU, and
  "forget" is deleting a list.
* **Human-processable pace.** Consecutive matches of one kind are one sound. Each kind has a hold
  time at least as long as the sound itself. A 30-second burst counter lets the agent say "four
  tickets in 30 seconds" rather than four lines, and the agent further merges repeats into one
  item with a count.

## Measured performance

Test material: five realistic sound effects (receipt printer, fryer alarm, door chime, phone,
plates crash; generated with ElevenLabs text-to-sound, 16 kHz) placed in a 78-second kitchen
room-tone track at known times, then degraded as a room would: distance attenuation, synthetic
reverb, added noise. `backend/tests/eval_ear.py` reproduces every number here.

| Scenario | Recall | False positives |
|---|---|---|
| Zero-shot, clean | 10/10 | 0 |
| Zero-shot, 4 m across the room (-18 dB, RT60 0.3 s, noise -46 dBFS) | 8/10 | 1 |
| Few-shot taught through that room, tested later in the same room | 8/10 | 1 |
| Few-shot, farther and noisier than taught (-26 dB, noise -42 dBFS) | 3/10 | 0 |
| Few-shot, whisper-level (-32 dB peak, 10 dB above the noise) | 0/10 | 0 |

Through the live server (`tests/e2e_backend.py`, soundtrack streamed as a microphone at 3× speed):
all five event kinds detected zero-shot with no false alarms; teaching the printer for six seconds then
replaying it gives `taught · 0.93`. The nose scenario sequence (spoilage → burning → cleaning → nominal)
produces exactly one correct event per scenario and nothing on nominal.

What this means for a deployment: out of the box the ears catch most alarms, chimes and phones
across a room with no false alarms. Teaching in place adds the printer and the clatter. Past
about 4 m in a loud room a second mic is the right fix, which is why mics are cheap and plural
in this design. We tuned on exactly these scenarios (`tests/sweep_ear.py`), so treat the numbers
as an upper bound for this material and a lower bound on what a mic placed near the source does.

## Why not a bigger model, or speech recognition

A kitchen's machine sounds are stereotyped; the hard part is *this* kitchen's versions of them,
which is a calibration problem, not a capacity problem. A 3.7 M-parameter embedding plus a dozen
prototypes solves calibration in seconds on a phone. Speech recognition would be more invasive,
far more expensive, and is not what the operational signals are.

## Honest limitations

* Cross-room generalisation of taught prototypes is weak at low SNR; teach where the mic lives.
* The zero-shot map is hand-written from AudioSet class names; a kitchen with an unusual alarm
  needs one teaching session.
* Evaluation uses synthetic room degradation of generated clips, not recordings from a real
  service. The first day with a real kitchen is: record an hour, label it, re-run the sweep.
