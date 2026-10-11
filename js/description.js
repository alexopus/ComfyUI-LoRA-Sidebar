// Reading and editing the "keywords: ..." / "weight: ..." lines of a description text.
// The patterns mirror the backend's parse_description (__init__.py); keep them in sync.

const LABEL_PATTERN = /^\s*(keywords|weight)\s*:\s*(.*)$/i;
const WEIGHT_ONLY_PATTERN = /^(?=.*\d)[\d.,\s\-–()]+$/;
const NUMBER_PATTERN = /(?<![\d.,])-?\d+(?:[.,]\d+)?/g;
const MAX_WEIGHT = 5;

function hasWeight(value) {
    return (value.match(NUMBER_PATTERN) || []).some(number => Math.abs(parseFloat(number.replace(',', '.'))) <= MAX_WEIGHT);
}

function splitLines(text) {
    return text.split(/\r\n|\r|\n/);
}

// { label, value } of a "keywords:" / "weight:" line, else null
function parseLabel(line) {
    const match = LABEL_PATTERN.exec(line);
    return match && { label: match[1].toLowerCase(), value: match[2].trim() };
}

// The line the backend takes a label's value from: the first one with a value, else the first one
function findLabelLine(lines, label) {
    const parsed = lines.map(parseLabel);
    const withValue = parsed.findIndex(p => p?.label === label && p.value);
    return withValue >= 0 ? withValue : parsed.findIndex(p => p?.label === label);
}

// A text without label lines: an optional leading weight-only line, the rest is the keywords
function readUnlabelled(text) {
    let body = splitLines(text.trim());
    let weight = '';
    if (WEIGHT_ONLY_PATTERN.test(body[0]) && hasWeight(body[0])) {
        weight = body[0].trim();
        body = body.slice(1);
    }
    return { weight, body, keywords: body.map(line => line.trim()).filter(Boolean).join(', ') };
}

/** The keywords and weight of a description as one-line texts ('' if none), as shown in the dialog's inputs. */
export function readFields(text) {
    const lines = splitLines(text);
    if (!lines.some(parseLabel)) {
        const { keywords, weight } = readUnlabelled(text);
        return { keywords, weight };
    }
    const valueOf = (label) => parseLabel(lines[findLabelLine(lines, label)] ?? '')?.value ?? '';
    return { keywords: valueOf('keywords'), weight: valueOf('weight') };
}

/**
 * Returns the description with its keywords or weight (`label`) set to `value`; an empty value removes it.
 * A text without label lines gets them: its keywords (the whole text) and leading weight become lines too,
 * as they'd stop counting otherwise.
 * @param options.keepBody on such a text, move the old text down as notes instead of turning it into
 *     (or replacing it as) the keywords; only a leading weight still becomes a line
 */
export function setField(text, label, value, { keepBody = false } = {}) {
    value = value.trim();
    const lines = splitLines(text);

    if (!lines.some(parseLabel)) {
        const current = readUnlabelled(text);
        const fields = { keywords: keepBody ? '' : current.keywords, weight: current.weight, [label]: value };
        const notes = keepBody && value ? current.body.join('\n').trim() : '';
        // Clearing one leaves the other as it was: nothing to label
        if (!value) return label === 'keywords' ? current.weight : current.body.join('\n').trim();
        return [
            fields.keywords && `keywords: ${fields.keywords}`,
            fields.weight && `weight: ${fields.weight}`,
            notes && `\n${notes}`,
        ].filter(Boolean).join('\n');
    }

    const index = findLabelLine(lines, label);
    if (value) {
        if (index >= 0) {
            lines[index] = `${label}: ${value}`;
        } else {
            // Keywords first, the weight right below them
            lines.splice(label === 'weight' ? findLabelLine(lines, 'keywords') + 1 : 0, 0, `${label}: ${value}`);
        }
    } else if (index >= 0) {
        lines.splice(index, 1);
        // Without any label line left, the remaining notes would turn into the keywords
        if (!lines.some(parseLabel) && lines.join('').trim()) lines.splice(index, 0, `${label}:`);
    }
    return lines.join('\n');
}
