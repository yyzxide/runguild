# Local bug target

Fix `normalizeTags(tags)` in `src/tags.mjs`.

Contract:

- reject a non-array or any non-string element with `TypeError`;
- trim surrounding whitespace and lowercase every tag;
- discard tags that become empty;
- remove duplicates after normalization; and
- preserve first-seen order.

Do not edit `test/acceptance.test.mjs`; it is the protected independent
acceptance contract.
