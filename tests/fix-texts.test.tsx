// Two messages Claude reads: the tool description and the nudge to carry on. Run with `node tests/only.mjs fix-texts`.
//
// How this can fail, and where each is tested below:
//  1. The description still says to stop the turn after a propose or a review advance, though the answer now comes back in
//     the same call, so Claude stops for nothing and waits for a message that never comes.
//  2. The description grows past what the model is given (4096 characters), and the end of it is cut.
//  3. The nudge names only a breaking escalation, so Claude waiting on the user for anything else gets pushed on instead
//     of being left to wait.
import { expect } from 'claude-code/testing'
import { DESCRIPTION, PUSH_HOW } from '../hooks/register'
import { test } from './kit'

test('the description fits what the model is given', () => {
  expect(DESCRIPTION.length).toBeLessThanOrEqual(4096)
})

test('the description lets the reply say whether to stop the turn', () => {
  // The answer comes back in the call when the user has a dialog; only without one does the reply say to stop.
  expect(DESCRIPTION).not.toMatch(/then stop your turn; edits open/)
  expect(DESCRIPTION).not.toMatch(/advance tells them, then stop your turn until they answer/)
  expect(DESCRIPTION).toMatch(/"after" on a state they review when done: advance asks them\./)
  expect(DESCRIPTION).toMatch(/[Ss]top your turn (only )?when the reply says to/)
})

test('the nudge keeps the breaking escalation and adds the blocked one for a question only the user can answer', () => {
  expect(PUSH_HOW).toMatch(/breaking-change decision \(escalate\)/)
  expect(PUSH_HOW).toMatch(/asked the user something only they can answer/)
  expect(PUSH_HOW).toMatch(/kind "blocked"/)
  expect(PUSH_HOW).toMatch(/stop/)
})
