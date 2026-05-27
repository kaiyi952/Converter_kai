const path = require('path');
const express = require('express');
const sanitizeHtml = require('sanitize-html');

const PORT = process.env.PORT || 3000;
const MAX_HTML_PAYLOAD_BYTES = 20 * 1024 * 1024;

const CANONICAL_TABLE_OPEN_TAG =
    '<table style="\n    width: 100%;\n    border-collapse: collapse;\n    table-layout: fixed;\n    word-break: break-word;\n    font-size: 12px;\n" border="1">';

const ALLOWED_TAGS = [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'sub', 'sup',
    'ul', 'ol', 'li',
    'blockquote', 'pre', 'code',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
    'span', 'div',
];

const ALLOWED_ATTRIBUTES = {
    a: ['href'],
    img: ['src', 'alt'],
    td: ['colspan', 'rowspan'],
    th: ['colspan', 'rowspan'],
    p: ['style'],
};

const ALLOWED_STYLES = {
    p: {
        'padding-left': [/^\d+(?:px|em|rem|%)$/],
    },
};

const LIST_INDENT_PX_PER_LEVEL = 40;
const MSO_LIST_LEVEL_PATTERN = /mso-list\s*:\s*l\d+\s+level(\d+)/i;
const MSO_LIST_CLASS_PATTERN = /msolistparagraph/i;

const ANCHOR_TAG_PATTERN = /<a\s+([^>]*?)>([\s\S]*?)<\/a>/gi;
const HREF_ATTRIBUTE_PATTERN = /\bhref\s*=\s*("[^"]*"|'[^']*'|\S+)/i;
const URL_LIKE_PLAIN_TEXT_PATTERN = /^(?:https?:\/\/|www\.|mailto:|tel:)\S+$/i;
const HTML_TAG_PATTERN = /<[^>]+>/g;
const TRAILING_URL_PUNCTUATION_PATTERN = /[.,;:!?)}\]'"]+$/;

function unquoteAttributeValue(value) {
    const trimmed = value.trim();
    if (
        (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'"))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function stripTrailingUrlPunctuation(url) {
    if (!url) {
        return url;
    }

    let cleaned = url;
    let previous;

    do {
        previous = cleaned;
        cleaned = cleaned.replace(TRAILING_URL_PUNCTUATION_PATTERN, '');

        const openParens = (cleaned.match(/\(/g) || []).length;
        const closeParens = (cleaned.match(/\)/g) || []).length;
        if (closeParens > openParens) {
            cleaned = cleaned.replace(/\)+$/, '');
        }

        const openBrackets = (cleaned.match(/\[/g) || []).length;
        const closeBrackets = (cleaned.match(/\]/g) || []).length;
        if (closeBrackets > openBrackets) {
            cleaned = cleaned.replace(/\]+$/, '');
        }
    } while (cleaned !== previous);

    return cleaned;
}

function detectMsoListLevel(attribs) {
    const className = attribs.class || '';
    const styleValue = attribs.style || '';
    const looksLikeListParagraph =
        MSO_LIST_CLASS_PATTERN.test(className) || /mso-list\s*:/i.test(styleValue);

    if (!looksLikeListParagraph) {
        return 0;
    }

    const levelMatch = styleValue.match(MSO_LIST_LEVEL_PATTERN);
    return levelMatch ? parseInt(levelMatch[1], 10) : 1;
}

const WORD_GARBAGE_BEFORE_PARSE = [
    /<!--\[if[\s\S]*?\[endif\](?:--)?>/gi,
    /<!\[if[^\]]*\]>/gi,
    /<!\[endif\]>/gi,
    /<xml\b[\s\S]*?<\/xml>/gi,
    /<\?xml[\s\S]*?\?>/gi,
    /<!\[CDATA\[[\s\S]*?\]\]>/g,
];

const NAMESPACED_TAG_BLOCK_PATTERN = /<([a-z]+:[a-z][a-z0-9]*)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const SELF_CLOSING_NAMESPACED_TAG_PATTERN = /<\/?[a-z]+:[a-z][a-z0-9]*\b[^>]*\/?>/gi;
const REDUNDANT_NBSP_PATTERN = /(&nbsp;|\u00a0){2,}/gi;
const MULTIPLE_BLANK_LINES_PATTERN = /\n\s*\n\s*\n+/g;

function stripWordGarbage(html) {
    let cleaned = html;
    for (const pattern of WORD_GARBAGE_BEFORE_PARSE) {
        cleaned = cleaned.replace(pattern, '');
    }
    cleaned = cleaned.replace(NAMESPACED_TAG_BLOCK_PATTERN, '');
    cleaned = cleaned.replace(SELF_CLOSING_NAMESPACED_TAG_PATTERN, '');
    return cleaned;
}

function extractBodyContent(html) {
    const bodyMatch = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
    return bodyMatch ? bodyMatch[1] : html;
}

function sanitizePastedHtml(html) {
    return sanitizeHtml(html, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: ALLOWED_ATTRIBUTES,
        allowedStyles: ALLOWED_STYLES,
        allowedSchemes: ['http', 'https', 'mailto', 'tel', 'data'],
        allowedSchemesByTag: { img: ['http', 'https', 'data'] },
        nonTextTags: ['style', 'script', 'textarea', 'option', 'noscript', 'head', 'title', 'meta', 'link'],
        transformTags: {
            p: (tagName, attribs) => {
                const listLevel = detectMsoListLevel(attribs);
                if (listLevel > 0) {
                    return {
                        tagName: 'p',
                        attribs: { style: `padding-left: ${listLevel * LIST_INDENT_PX_PER_LEVEL}px` },
                    };
                }
                return { tagName, attribs };
            },
        },
        exclusiveFilter: (frame) => {
            const tagName = frame.tag;
            if (['span', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
                const text = (frame.text || '').replace(/\u00a0/g, '').trim();
                const hasMedia = frame.mediaChildren && frame.mediaChildren.length > 0;
                if (!text && !hasMedia) {
                    return true;
                }
            }
            return false;
        },
    });
}

function applyTableTemplate(html) {
    return html.replace(/<table\s*>/gi, CANONICAL_TABLE_OPEN_TAG);
}

function alignAnchorHrefToText(html) {
    return html.replace(ANCHOR_TAG_PATTERN, (fullMatch, attrs, innerContent) => {
        const plainText = innerContent.replace(HTML_TAG_PATTERN, '').replace(/\s+/g, ' ').trim();
        const urlFromText = stripTrailingUrlPunctuation(plainText);

        const hrefMatch = attrs.match(HREF_ATTRIBUTE_PATTERN);
        const originalHref = hrefMatch ? unquoteAttributeValue(hrefMatch[1]) : '';
        let href = stripTrailingUrlPunctuation(originalHref);

        if (URL_LIKE_PLAIN_TEXT_PATTERN.test(urlFromText)) {
            href = urlFromText.startsWith('www.') ? `http://${urlFromText}` : urlFromText;
        }

        if (!href && !hrefMatch) {
            return fullMatch;
        }

        if (href === originalHref && !URL_LIKE_PLAIN_TEXT_PATTERN.test(urlFromText)) {
            return fullMatch;
        }

        const safeHref = href.replace(/"/g, '&quot;');
        const attrsWithoutHref = attrs.replace(HREF_ATTRIBUTE_PATTERN, '').trim();
        const restAttrs = attrsWithoutHref ? ` ${attrsWithoutHref}` : '';

        return `<a href="${safeHref}"${restAttrs}>${innerContent}</a>`;
    });
}

function postProcess(html) {
    let output = html;
    output = output.replace(REDUNDANT_NBSP_PATTERN, '&nbsp;');
    output = output.replace(MULTIPLE_BLANK_LINES_PATTERN, '\n\n');
    return output.trim();
}

function cleanHtml(rawHtml) {
    if (!rawHtml || !rawHtml.trim()) {
        return '';
    }

    const bodyOnly = extractBodyContent(rawHtml);
    const stripped = stripWordGarbage(bodyOnly);
    const sanitized = sanitizePastedHtml(stripped);
    const aligned = alignAnchorHrefToText(sanitized);
    const tabled = applyTableTemplate(aligned);
    return postProcess(tabled);
}

const app = express();

app.use(express.json({ limit: MAX_HTML_PAYLOAD_BYTES }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/convert', (req, res) => {
    try {
        const inputHtml = req.body && typeof req.body.html === 'string' ? req.body.html : '';

        if (!inputHtml.trim()) {
            return res.status(400).json({ error: 'No HTML content provided' });
        }

        const cleanedHtml = cleanHtml(inputHtml);
        res.json({ html: cleanedHtml });
    } catch (err) {
        console.error('Conversion failed:', err);
        res.status(500).json({ error: 'Conversion failed', detail: err.message });
    }
});

app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'Pasted content is too large' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});
