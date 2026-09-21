export interface TriviaCursor {
  readonly cursor: number
  readonly malformed: boolean
}

export const lineCommentEnd = (source: string, start: number): number => {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === "\r" || char === "\n") return index + (char === "\r" && source[index + 1] === "\n" ? 2 : 1)
  }
  return source.length
}

export const skipPhpTrivia = (source: string, start: number): TriviaCursor => {
  let cursor = start
  while (cursor < source.length) {
    while (cursor < source.length && /\s/.test(source[cursor] ?? "")) cursor += 1
    if (source[cursor] === "/" && source[cursor + 1] === "/") {
      cursor = lineCommentEnd(source, cursor + 2)
      continue
    }
    if (source[cursor] === "#") {
      cursor = lineCommentEnd(source, cursor + 1)
      continue
    }
    if (source[cursor] === "/" && source[cursor + 1] === "*") {
      const end = source.indexOf("*/", cursor + 2)
      if (end < 0) return { cursor: source.length, malformed: true }
      cursor = end + 2
      continue
    }
    break
  }
  return { cursor, malformed: false }
}
