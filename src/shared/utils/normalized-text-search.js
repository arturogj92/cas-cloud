/**
 * Case/diacritic-insensitive substring location that maps back to ORIGINAL
 * string offsets.
 *
 * The conversation search services match on a normalized copy of the text
 * (NFD + strip \p{Diacritic} + lowercase). That normalization DELETES
 * characters — not only combining marks: standalone marks like the backtick
 * "`" (U+0060) have the Diacritic property too — so an index found in
 * normalized space does not line up with the original string. In a
 * code-heavy message full of backticks the drift reaches hundreds of
 * characters, which used to make search snippets show text far away from
 * the real match (and therefore no highlight).
 *
 * buildNormalizedMap keeps a normalized→original index map so callers can
 * slice the ORIGINAL string at the right place. Matching semantics stay
 * identical to the services' normalizeString (what matched there maps here).
 */
(function () {
    const DIACRITICS_RE = /\p{Diacritic}/gu;

    /**
     * Normalized (diacritic-stripped, lowercased) copy of `text` plus a map
     * from each normalized index back to the original index. Built char by
     * char because normalization can change string length (e.g. "İ" → "i̇",
     * "`" → "").
     */
    function buildNormalizedMap(text) {
        const str = String(text);
        let norm = '';
        const map = [];
        for (let i = 0; i < str.length; i++) {
            const n = str[i].normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();
            for (let j = 0; j < n.length; j++) {
                norm += n[j];
                map.push(i);
            }
        }
        return { norm, map };
    }

    const WORD_CHAR_RE = /[\p{L}\p{N}_]/u;

    /**
     * True when the occurrence of a `length`-char query at `index` in `str`
     * is a whole word: not glued to a letter/number/underscore on either
     * side. This is THE word-boundary definition for the whole-word search
     * filter — keep the services and the renderer highlighter on it.
     */
    function isWholeWordAt(str, index, length) {
        const before = index > 0 ? str[index - 1] : '';
        const after = index + length < str.length ? str[index + length] : '';
        return !(before && WORD_CHAR_RE.test(before)) && !(after && WORD_CHAR_RE.test(after));
    }

    /**
     * Index of the first occurrence of `query` in `str`, honoring the
     * whole-word option. Both are expected already normalized. -1 = no match.
     */
    function indexOfNormalized(str, query, wholeWord = false) {
        let idx = str.indexOf(query);
        if (!wholeWord) return idx;
        while (idx !== -1) {
            if (isWholeWordAt(str, idx, query.length)) return idx;
            idx = str.indexOf(query, idx + 1);
        }
        return -1;
    }

    /**
     * Match test for the search services' hot loop: both args already went
     * through their normalizeString + toLowerCase, so no map is built here.
     */
    function matchesNormalized(normalizedContent, normalizedQuery, wholeWord = false) {
        return indexOfNormalized(normalizedContent, normalizedQuery, wholeWord) !== -1;
    }

    /**
     * First occurrence of `query` in `text`, case/diacritic-insensitive.
     * Returns { start, end } as ORIGINAL-string indices ([start, end) range),
     * or null when there is no match.
     */
    function findNormalizedMatch(text, query, options = {}) {
        if (!text || !query) return null;
        const q = String(query).normalize('NFD').replace(DIACRITICS_RE, '').toLowerCase();
        if (!q) return null;
        const { norm, map } = buildNormalizedMap(text);
        const idx = indexOfNormalized(norm, q, options.wholeWord === true);
        if (idx === -1) return null;
        return { start: map[idx], end: map[idx + q.length - 1] + 1 };
    }

    const api = { buildNormalizedMap, findNormalizedMatch, matchesNormalized, indexOfNormalized, isWholeWordAt };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
    if (typeof window !== 'undefined') {
        window.NormalizedTextSearch = api;
    }
})();
