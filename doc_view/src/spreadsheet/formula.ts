// Lightweight, secure formula parser and evaluator for spreadsheets.
// Supported subset:
// - Arithmetic: +, -, *, /, ^, %
// - Comparison: =, <>, !=, <, <=, >, >=
// - Unary: +, -
// - References: Single cells (e.g. A1, $B$2), cell ranges (e.g. C2:C8)
// - Math functions: PI(), ROUND(v, [digits]), INT(v), ABS(v), SQRT(v), POWER(b, e), MOD(n, d)
// - Aggregation functions: SUM(range/list), AVERAGE(range/list), MIN(...), MAX(...), COUNT(...), COUNTA(...)
// - Logical functions: IF(cond, trueVal, falseVal), AND(...), OR(...), NOT(v), TRUE(), FALSE()

import { parseCellColRow, colRowToCellRef } from './render.js'

export interface FormulaCell {
  rawVal?: string | number | null
  formula?: string | null
}

export type CellResolver = (ref: string) => FormulaCell | undefined

export interface FormulaEvalResult {
  success: boolean
  value: number | string | boolean | null
  error?: string
}

type TokenType =
  | 'NUMBER'
  | 'STRING'
  | 'BOOLEAN'
  | 'CELL'
  | 'RANGE'
  | 'IDENT'
  | 'OP'
  | 'LPAREN'
  | 'RPAREN'
  | 'COMMA'
  | 'EOF'

interface Token {
  type: TokenType
  value: string
  numValue?: number
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9'
}

function isAlpha(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_'
}

function isAlphaNum(ch: string): boolean {
  return isAlpha(ch) || isDigit(ch) || ch === '$'
}

export function tokenizeFormula(expr: string): Token[] {
  const tokens: Token[] = []
  let i = 0
  const s = expr.trim().startsWith('=') ? expr.trim().slice(1) : expr.trim()
  const len = s.length

  while (i < len) {
    const ch = s[i]

    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i++
      continue
    }

    if (isDigit(ch) || (ch === '.' && i + 1 < len && isDigit(s[i + 1]))) {
      let numStr = ''
      while (i < len && (isDigit(s[i]) || s[i] === '.')) {
        numStr += s[i++]
      }
      if (i < len && (s[i] === 'e' || s[i] === 'E')) {
        let expStr = s[i++]
        if (i < len && (s[i] === '+' || s[i] === '-')) {
          expStr += s[i++]
        }
        while (i < len && isDigit(s[i])) {
          expStr += s[i++]
        }
        numStr += expStr
      }
      tokens.push({ type: 'NUMBER', value: numStr, numValue: parseFloat(numStr) })
      continue
    }

    if (ch === '"' || ch === "'") {
      const quote = ch
      i++
      let str = ''
      while (i < len && s[i] !== quote) {
        if (s[i] === '\\' && i + 1 < len) {
          i++
          str += s[i++]
        } else {
          str += s[i++]
        }
      }
      if (i < len && s[i] === quote) i++
      tokens.push({ type: 'STRING', value: str })
      continue
    }

    if (isAlpha(ch) || ch === '$') {
      let ident = ''
      while (i < len && isAlphaNum(s[i])) {
        ident += s[i++]
      }

      if (i < len && s[i] === ':') {
        i++
        let secondIdent = ''
        while (i < len && isAlphaNum(s[i])) {
          secondIdent += s[i++]
        }
        tokens.push({ type: 'RANGE', value: `${ident}:${secondIdent}` })
        continue
      }

      const upper = ident.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') {
        tokens.push({ type: 'BOOLEAN', value: upper })
      } else if (i < len && s[i] === '(') {
        tokens.push({ type: 'IDENT', value: upper })
      } else if (/^\$?[A-Z]+\$?[0-9]+$/i.test(ident)) {
        tokens.push({ type: 'CELL', value: upper.replace(/\$/g, '') })
      } else {
        tokens.push({ type: 'IDENT', value: upper })
      }
      continue
    }

    if (ch === '<') {
      if (i + 1 < len && s[i + 1] === '>') {
        tokens.push({ type: 'OP', value: '<>' })
        i += 2
        continue
      }
      if (i + 1 < len && s[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '<=' })
        i += 2
        continue
      }
      tokens.push({ type: 'OP', value: '<' })
      i++
      continue
    }

    if (ch === '>') {
      if (i + 1 < len && s[i + 1] === '=') {
        tokens.push({ type: 'OP', value: '>=' })
        i += 2
        continue
      }
      tokens.push({ type: 'OP', value: '>' })
      i++
      continue
    }

    if (ch === '!' && i + 1 < len && s[i + 1] === '=') {
      tokens.push({ type: 'OP', value: '<>' })
      i += 2
      continue
    }

    if (ch === '=') {
      tokens.push({ type: 'OP', value: '=' })
      i++
      continue
    }

    if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '^' || ch === '%') {
      tokens.push({ type: 'OP', value: ch })
      i++
      continue
    }

    if (ch === '(') {
      tokens.push({ type: 'LPAREN', value: '(' })
      i++
      continue
    }

    if (ch === ')') {
      tokens.push({ type: 'RPAREN', value: ')' })
      i++
      continue
    }

    if (ch === ',' || ch === ';') {
      tokens.push({ type: 'COMMA', value: ',' })
      i++
      continue
    }

    i++
  }

  tokens.push({ type: 'EOF', value: '' })
  return tokens
}

export class FormulaParser {
  private tokens: Token[] = []
  private pos = 0
  private resolver: CellResolver
  private visiting: Set<string>

  constructor(tokens: Token[], resolver: CellResolver, visiting: Set<string>) {
    this.tokens = tokens
    this.pos = 0
    this.resolver = resolver
    this.visiting = visiting
  }

  private peek(): Token {
    return this.tokens[this.pos] || { type: 'EOF', value: '' }
  }

  private next(): Token {
    const tok = this.peek()
    if (this.pos < this.tokens.length) {
      this.pos++
    }
    return tok
  }

  private match(type: TokenType, val?: string): boolean {
    const tok = this.peek()
    if (tok.type === type && (val === undefined || tok.value === val)) {
      this.next()
      return true
    }
    return false
  }

  public parse(): any {
    const res = this.parseComparison()
    if (this.peek().type !== 'EOF') {
      throw new Error('#VALUE!')
    }
    return res
  }

  private parseComparison(): any {
    let left = this.parseAdditive()

    while (this.peek().type === 'OP' && ['=', '<>', '<', '<=', '>', '>='].includes(this.peek().value)) {
      const op = this.next().value
      const right = this.parseAdditive()
      switch (op) {
        case '=': left = left === right; break
        case '<>': left = left !== right; break
        case '<': left = Number(left) < Number(right); break
        case '<=': left = Number(left) <= Number(right); break
        case '>': left = Number(left) > Number(right); break
        case '>=': left = Number(left) >= Number(right); break
      }
    }
    return left
  }

  private parseAdditive(): any {
    let left = this.parseMultiplicative()

    while (this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value
      const right = this.parseMultiplicative()
      left = op === '+' ? Number(left) + Number(right) : Number(left) - Number(right)
    }
    return left
  }

  private parseMultiplicative(): any {
    let left = this.parsePower()

    while (this.peek().type === 'OP' && (this.peek().value === '*' || this.peek().value === '/')) {
      const op = this.next().value
      const right = this.parsePower()
      if (op === '*') {
        left = Number(left) * Number(right)
      } else {
        const denom = Number(right)
        if (denom === 0) throw new Error('#DIV/0!')
        left = Number(left) / denom
      }
    }
    return left
  }

  private parsePower(): any {
    let left = this.parseUnary()

    while (this.peek().type === 'OP' && this.peek().value === '^') {
      this.next()
      const right = this.parseUnary()
      left = Math.pow(Number(left), Number(right))
    }
    return left
  }

  private parseUnary(): any {
    if (this.peek().type === 'OP' && (this.peek().value === '+' || this.peek().value === '-')) {
      const op = this.next().value
      const val = this.parseUnary()
      return op === '-' ? -Number(val) : Number(val)
    }
    return this.parsePrimary()
  }

  private parsePrimary(): any {
    const tok = this.peek()

    if (tok.type === 'NUMBER') {
      this.next()
      return tok.numValue ?? parseFloat(tok.value)
    }
    if (tok.type === 'STRING') {
      this.next()
      return tok.value
    }
    if (tok.type === 'BOOLEAN') {
      this.next()
      return tok.value === 'TRUE'
    }
    if (tok.type === 'LPAREN') {
      this.next()
      const expr = this.parseComparison()
      if (!this.match('RPAREN')) throw new Error('#VALUE!')
      return expr
    }
    if (tok.type === 'CELL') {
      this.next()
      return this.resolveCellValue(tok.value)
    }
    if (tok.type === 'RANGE') {
      this.next()
      return this.resolveRangeValues(tok.value)
    }
    if (tok.type === 'IDENT') {
      const funcName = this.next().value
      if (!this.match('LPAREN')) throw new Error('#NAME?')

      const args: any[] = []
      if (!this.match('RPAREN')) {
        while (true) {
          if (this.peek().type === 'RANGE') {
            args.push(this.resolveRangeValues(this.next().value))
          } else {
            args.push(this.parseComparison())
          }
          if (this.match('COMMA')) continue
          if (this.match('RPAREN')) break
          throw new Error('#VALUE!')
        }
      }
      return this.evaluateFunction(funcName, args)
    }

    throw new Error('#VALUE!')
  }

  private resolveCellValue(ref: string): any {
    const upperRef = ref.toUpperCase()
    if (this.visiting.has(upperRef)) throw new Error('#CIRCULAR!')

    const cell = this.resolver(upperRef)
    if (!cell) return 0

    if (cell.formula) {
      this.visiting.add(upperRef)
      try {
        const subRes = evaluateFormula(cell.formula, this.resolver, this.visiting)
        if (!subRes.success) {
          if (subRes.error === '#CIRCULAR!' || subRes.error === '#DIV/0!') throw new Error(subRes.error)
          if (cell.rawVal !== undefined && cell.rawVal !== null && cell.rawVal !== '') {
            const n = Number(cell.rawVal)
            return isNaN(n) ? cell.rawVal : n
          }
          throw new Error(subRes.error || '#VALUE!')
        }
        return subRes.value
      } finally {
        this.visiting.delete(upperRef)
      }
    }

    if (cell.rawVal === undefined || cell.rawVal === null || cell.rawVal === '') return 0
    const num = Number(cell.rawVal)
    return isNaN(num) ? cell.rawVal : num
  }

  private resolveRangeValues(rangeStr: string): number[] {
    const [startRef, endRef] = rangeStr.split(':')
    const start = parseCellColRow(startRef)
    const end = parseCellColRow(endRef)
    if (!start || !end) return []

    const minCol = Math.min(start.col, end.col)
    const maxCol = Math.max(start.col, end.col)
    const minRow = Math.min(start.row, end.row)
    const maxRow = Math.max(start.row, end.row)

    const values: number[] = []
    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        const ref = colRowToCellRef(c, r)
        try {
          const val = this.resolveCellValue(ref)
          if (typeof val === 'number' && !isNaN(val)) {
            values.push(val)
          } else if (typeof val === 'string' && val.trim() !== '') {
            const parsed = Number(val)
            if (!isNaN(parsed)) values.push(parsed)
          }
        } catch (e: any) {
          if (e?.message === '#CIRCULAR!') throw e
        }
      }
    }
    return values
  }

  private evaluateFunction(name: string, args: any[]): any {
    const flattenNumbers = (items: any[]): number[] => {
      const res: number[] = []
      for (const item of items) {
        if (Array.isArray(item)) {
          res.push(...flattenNumbers(item))
        } else if (typeof item === 'number' && !isNaN(item)) {
          res.push(item)
        } else if (typeof item === 'string' && item.trim() !== '') {
          const n = Number(item)
          if (!isNaN(n)) res.push(n)
        }
      }
      return res
    }

    switch (name) {
      case 'PI': return Math.PI
      case 'SUM': return flattenNumbers(args).reduce((acc, v) => acc + v, 0)
      case 'AVERAGE': {
        const nums = flattenNumbers(args)
        if (nums.length === 0) throw new Error('#DIV/0!')
        return nums.reduce((acc, v) => acc + v, 0) / nums.length
      }
      case 'MIN': {
        const nums = flattenNumbers(args)
        return nums.length === 0 ? 0 : Math.min(...nums)
      }
      case 'MAX': {
        const nums = flattenNumbers(args)
        return nums.length === 0 ? 0 : Math.max(...nums)
      }
      case 'COUNT': return flattenNumbers(args).length
      case 'COUNTA': {
        let count = 0
        for (const a of args) {
          if (Array.isArray(a)) count += a.length
          else if (a !== null && a !== undefined && a !== '') count++
        }
        return count
      }
      case 'ROUND': {
        if (args.length < 1) throw new Error('#VALUE!')
        const factor = Math.pow(10, args.length >= 2 ? Number(args[1]) : 0)
        return Math.round(Number(args[0]) * factor) / factor
      }
      case 'INT': return args.length < 1 ? 0 : Math.floor(Number(args[0]))
      case 'ABS': return args.length < 1 ? 0 : Math.abs(Number(args[0]))
      case 'SQRT': {
        if (args.length < 1) throw new Error('#VALUE!')
        const v = Number(args[0])
        if (v < 0) throw new Error('#NUM!')
        return Math.sqrt(v)
      }
      case 'POWER': {
        if (args.length < 2) throw new Error('#VALUE!')
        return Math.pow(Number(args[0]), Number(args[1]))
      }
      case 'MOD': {
        if (args.length < 2) throw new Error('#VALUE!')
        const divisor = Number(args[1])
        if (divisor === 0) throw new Error('#DIV/0!')
        return Number(args[0]) % divisor
      }
      case 'IF': return Boolean(args[0]) ? args[1] : (args.length >= 3 ? args[2] : false)
      case 'AND': return args.every(Boolean)
      case 'OR': return args.some(Boolean)
      case 'NOT': return !Boolean(args[0])
      case 'TRUE': return true
      case 'FALSE': return false
      default: throw new Error('#NAME?')
    }
  }
}

export function evaluateFormula(
  formula: string,
  resolver: CellResolver,
  visiting: Set<string> = new Set()
): FormulaEvalResult {
  try {
    const tokens = tokenizeFormula(formula)
    const parser = new FormulaParser(tokens, resolver, visiting)
    return { success: true, value: parser.parse() }
  } catch (err: any) {
    const errMsg = err?.message || '#VALUE!'
    return {
      success: false,
      value: null,
      error: errMsg.startsWith('#') ? errMsg : '#VALUE!',
    }
  }
}