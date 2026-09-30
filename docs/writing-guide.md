# Technical writing guide

Write for someone about to run the project. Explain what it does, what it needs,
how to start it, what can fail, and where to find the details.

- Put hard dependencies and major limits before installation. Separate
  requirements, failure symptoms, and missing features.
- Give one working install path first. Put variations in the reference section.
- Describe behavior in the sentence. Add a command, number, test, or source link
  for verification; a link does not replace the explanation.
- Give available measurements once, with hardware, date, inputs, and scope.
  Distinguish measured results from extrapolations. Asking the reader to measure
  is a fallback, not a replacement for numbers already available.
- Make caveats actionable. Say what to check, change, or report. Start every item
  in a failure-mode list with the symptom the reader sees.
- State each instruction once and link back to it. Check for duplicate commands
  and stale descriptions after changing code.
- Put one fact in each sentence. Name the actor and use an active verb. Explain
  jargon on first use.
- Use the imperative for instructions. Use “I” for documented decisions and
  history. Keep mistakes and measurements that explain a change; do not invent
  a first-person story to make a reference section sound personal.
- Before deleting a number or anecdote, check whether it is evidence rather than
  decoration. Move longer history to design notes when it interrupts instructions.
- Cut praise, announced emotion, slogans, and claims larger than the evidence.
  State missing features and untested configurations without apology.

Review: could the reader act on each section? Could they verify each behavior
claim? Would any sentence fit under a conference photo of the author? Read it
aloud and cut sentences that sound like a pitch.
