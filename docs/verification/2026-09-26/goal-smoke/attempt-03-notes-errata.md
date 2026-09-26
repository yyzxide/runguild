# Manual corrections to the archived research notes

Artifact commit: `eb789a00bcc066c0cd6b03e8ee5240c36f79e9b6`.

These corrections accompany the unchanged original artifact. They do not alter the recorded model output or expand the completed nine-check functional scope.

## 1. docs/analysis.md:97

**Original claim:** values[i] !== undefined rejects the legitimate string undefined.

**Correction:** The string "undefined" is not equal to the value undefined, so this comparison accepts that string. The comparison is insufficient because it neither checks own-property presence nor establishes that a present value is a string.

**Counterexample:** "undefined" !== undefined evaluates to true.

## 2. docs/analysis.md:133

**Original claim:** map and filter preserve holes in their output.

**Correction:** For ordinary holes with no inherited indexed property, map skips the callback and preserves the corresponding output hole. filter also skips the callback, but appends selected present values consecutively to a dense result. forEach has no array output. for...of and array spread yield undefined for ordinary holes.

**Counterexample:** ["a", , "c"].filter(() => true) is ["a", "c"] with length 2; the equivalent map output has length 3 and no own index 1.

## 3. docs/analysis.md:179

**Original claim:** An array can be frozen before or after deleting an existing own slot and have a hole afterward in either case.

**Correction:** Deleting a configurable own slot before freezing creates a hole that remains after freezing. Freezing first makes existing own slots non-configurable, so deleting one fails: it throws TypeError in ESM/strict mode and returns false in non-strict code. The slot remains present.

**Counterexample:** delete Object.freeze(["a"])[0] throws TypeError in ESM; Object.hasOwn(array, 0) remains true.
