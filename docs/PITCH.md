# Sous — pitch script and deck (3 minutes + demo)

## One line
Restaurants run on sounds and smells nobody is paid to notice. Sous gives the kitchen ears and a
nose, and turns what they sense into a short list of things to do.

## Slides

**1. The problem (20 s)**
A line cook at 7 pm hears the printer, the fryer, the door and the phone at once and decides in
half a second what matters. The owner at 11 pm finds the avocados turned and the fryer oil burnt.
Missing items and dishes sold online after they ran out are the top merchant refund driver; the
margin is 3 to 5 percent. Every one of those failures was audible or smellable first.

**2. The idea (20 s)**
Cameras are the obvious sensor. We built the other two senses, and an agent that turns their
signals into one prioritised list: Now, Next, Today. The owner follows the list; the system does
the rest, including fixing the storefront before a customer orders something the kitchen cannot make.

**3. Ears (30 s)**
A $0 microphone, a laptop or a phone. A 3.7-million-parameter audio model (YAMNet) runs in 7 ms
per second of audio on a CPU. Out of the box it recognises alarms, chimes and phones; teach it your
printer in four seconds through the real mic and it is calibrated to your room, with the room's own
noise mixed in so it survives a loud service. Multiple mics, each with a location. Measured: 9/10
recall with zero false alarms across a room on our test set.

**4. Nose (30 s)**
A $12 to $30 metal-oxide gas sensor. We use the heater-sweep fingerprint: four heater temperatures,
four resistances, and the shape across them tells produce fermenting from protein spoiling from
burning from a cleaning product. It calibrates itself: baseline, drift, humidity slope. A gradient-
boosted classifier the size of a photo runs anywhere. Urgency comes from physics: burning is now,
oil is before the rush, spoilage is today, bleach is ignore.

**5. Agent (20 s)**
Every signal becomes at most one item with evidence attached. Repeats become a count. Items close
themselves when the Dasher leaves or the air clears. Predicted stockouts pull dishes from DoorDash
and Uber Eats, promote a substitute, and draft the reorder. The voice speaks only for "now".

**6. Live demo (90 s)** — unscripted: the judge taps sounds on the phone.

**7. Honest seams and next day (20 s)**
No gas board today: the nose runs on replayed sensor physics through the same endpoint the ESP32
posts to; the classifier is trained on that physics, so its 0.95 accuracy is an upper bound until
it sees a real cooler. Day one with hardware: log, label, retrain, same code. Next: DoorDash
Merchant Menu API for the storefront actions, order webhook for the stream.

## Demo script (judge-driven)

1. Board open on the projector. Listen is on, location kitchen. Hand over the phone at `/#/sounds`.
2. "Tap anything." Door chime → Board: *Someone at the front door* (next). Fryer alarm with nothing
   frying → *Check station 2* (now) and the voice says so. Phone → *Pick up* (now). Tap the same
   sound again → the count goes to ×2, no second line.
3. Ears page. "Teach → Ticket printer", judge plays the printer during the countdown. Play it again:
   the event row says `taught · 0.9x`. Press Forget: back to zero-shot.
4. Nose page. Judge picks any scenario. Produce spoilage: bars climb, probability wins, a *today*
   item with "Sous did: 20% off avocado dishes, reorder skipped", Storefront shows the discounts.
   Burning: all bars jump, *now*, voice. Cleaning: one bar drops below 1.0, informational, expires.
   Say the no-board caveat out loud.
5. Rush on. Within a minute: avocado pulled from the delivery apps, substitute promoted, *next* item
   asking to approve the reorder. Press "We got more" on the Storefront: the item closes itself.
6. Dismiss anything. Point at the evidence rows. Done.

## If asked

* Why not a camera? Grease, privacy, staff morale, and the signals that matter are acoustic and
  chemical anyway.
* Why a small model? Calibration is the hard part, not capacity. Prototypes beat retraining.
* Why trust the nose numbers? You should not yet. The pipeline is real; the training data is physics.
* Cost per station: a phone you already own for the ears; under $35 for the nose.
