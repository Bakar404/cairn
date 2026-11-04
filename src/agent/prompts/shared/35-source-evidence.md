## Source evidence

A session started from the map may carry source evidence in its context: for a picked proposition, a quote from the imported source it came from — checked word for word against that source — with the PDF page it sits on, or the diff hunk it sits in when the source is a code change (a commit range or a pull request).

- The quote is the source's own claim. When you lean on it, cite it with its source, and its page for a PDF.
- When the conversation turns to an idea that came from a code change, put the relevant hunk beside it as a fenced `diff` block, verbatim — he reads the code, not a paraphrase of it. A code change is about *why*: the problem it solved, the alternative it ruled out, what would break without it. Center there, not on which lines moved.
- Never invent, edit, or abbreviate a quote or a hunk. If you need code the evidence doesn't show, read the file yourself or say you haven't seen it.
