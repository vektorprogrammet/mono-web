export type JsonMemberScanResult = "valid" | "duplicate" | "malformed"
export const inspectJsonMembers = (text: string): JsonMemberScanResult => {
  let index = 0
  const skipWhitespace = (): void => {
    while (index < text.length && /\s/.test(text[index] as string)) index += 1
  }
  const parseString = (): string => {
    const start = index
    if (text[index] !== "\"") throw new Error("json string expected")
    index += 1
    while (index < text.length) {
      const character = text[index]
      if (character === "\\") {
        index += 2
        continue
      }
      index += 1
      if (character === "\"") return text.slice(start, index)
      if (character !== undefined && character < " ") throw new Error("json control character")
    }
    throw new Error("unterminated json string")
  }
  const parseValue = (): boolean => {
    skipWhitespace()
    const character = text[index]
    if (character === "{") {
      index += 1
      skipWhitespace()
      const keys = new Set<string>()
      if (text[index] === "}") {
        index += 1
        return false
      }
      while (true) {
        skipWhitespace()
        const key = JSON.parse(parseString()) as unknown
        if (typeof key !== "string") throw new Error("json member key expected")
        const duplicate = keys.has(key)
        keys.add(key)
        skipWhitespace()
        if (text[index] !== ":") throw new Error("json member separator expected")
        index += 1
        const nestedDuplicate = parseValue()
        if (duplicate || nestedDuplicate) return true
        skipWhitespace()
        if (text[index] === "}") {
          index += 1
          return false
        }
        if (text[index] !== ",") throw new Error("json member delimiter expected")
        index += 1
      }
    }
    if (character === "[") {
      index += 1
      skipWhitespace()
      if (text[index] === "]") {
        index += 1
        return false
      }
      while (true) {
        if (parseValue()) return true
        skipWhitespace()
        if (text[index] === "]") {
          index += 1
          return false
        }
        if (text[index] !== ",") throw new Error("json array delimiter expected")
        index += 1
      }
    }
    if (character === "\"") {
      parseString()
      return false
    }
    const start = index
    while (index < text.length && !/[\s,[\]{}:]/.test(text[index] as string)) index += 1
    if (index === start) throw new Error("json value expected")
    return false
  }
  try {
    const duplicate = parseValue()
    if (duplicate) return "duplicate"
    skipWhitespace()
    if (index !== text.length) return "malformed"
    return "valid"
  } catch {
    return "malformed"
  }
}
export const hasDuplicateJsonMembers = (text: string): boolean =>
  inspectJsonMembers(text) !== "valid"
