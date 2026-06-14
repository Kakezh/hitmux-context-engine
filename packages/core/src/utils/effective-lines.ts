export function countEffectiveLinesInContent(content: string): number {
    const lines = content.split(/\r?\n/);
    let effectiveLines = 0;
    let inBlockComment = false;

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
            continue;
        }

        const result = stripLeadingCommentOnlySyntax(trimmed, inBlockComment);
        inBlockComment = result.inBlockComment;
        if (result.hasCode) {
            effectiveLines++;
        }
    }

    return effectiveLines;
}

function stripLeadingCommentOnlySyntax(line: string, inBlockComment: boolean): { hasCode: boolean; inBlockComment: boolean } {
    let remaining = line;
    let blockCommentOpen = inBlockComment;

    while (remaining.length > 0) {
        if (blockCommentOpen) {
            const blockEnd = remaining.indexOf('*/');
            if (blockEnd === -1) {
                return { hasCode: false, inBlockComment: true };
            }
            remaining = remaining.slice(blockEnd + 2).trimStart();
            blockCommentOpen = false;
            continue;
        }

        if (remaining.startsWith('/*')) {
            const blockEnd = remaining.indexOf('*/', 2);
            if (blockEnd === -1) {
                return { hasCode: false, inBlockComment: true };
            }
            remaining = remaining.slice(blockEnd + 2).trimStart();
            continue;
        }

        if (remaining.startsWith('<!--')) {
            const htmlCommentEnd = remaining.indexOf('-->', 4);
            if (htmlCommentEnd === -1) {
                return { hasCode: false, inBlockComment: false };
            }
            remaining = remaining.slice(htmlCommentEnd + 3).trimStart();
            continue;
        }

        if (
            remaining.startsWith('//') ||
            remaining.startsWith('#') ||
            remaining.startsWith('--')
        ) {
            return { hasCode: false, inBlockComment: false };
        }

        return { hasCode: true, inBlockComment: false };
    }

    return { hasCode: false, inBlockComment: blockCommentOpen };
}
