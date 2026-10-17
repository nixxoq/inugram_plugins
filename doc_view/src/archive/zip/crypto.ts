const CRC32_TABLE = new Uint32Array(256)
for (let i = 0; i < 256; i++) {
  let c = i
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  }
  CRC32_TABLE[i] = c >>> 0
}

function crc32Update(prevCrc: number, b: number): number {
  return (CRC32_TABLE[(prevCrc ^ b) & 0xff] ^ (prevCrc >>> 8)) >>> 0
}

export class ZipCryptoEngine {
  private key0 = 0x12345678
  private key1 = 0x23456789
  private key2 = 0x34567890

  constructor(password: string) {
    const bytes = new TextEncoder().encode(password)
    for (let i = 0; i < bytes.length; i++) {
      this.updateKeys(bytes[i])
    }
  }

  private updateKeys(byteVal: number): void {
    const b = byteVal & 0xff
    this.key0 = crc32Update(this.key0, b)
    this.key1 = (Math.imul((this.key1 + (this.key0 & 0xff)) | 0, 134775813) + 1) >>> 0
    this.key2 = crc32Update(this.key2, this.key1 >>> 24)
  }

  decryptByte(cipherByte: number): number {
    const temp = (this.key2 | 2) >>> 0
    const k = Math.imul(temp, temp ^ 1) >>> 8
    const plain = (cipherByte ^ (k & 0xff)) & 0xff
    this.updateKeys(plain)
    return plain
  }

  static verifyHeader(
    headerBytes: Uint8Array,
    password: string,
    expectedCheckByte: number
  ): { isValid: boolean; engine: ZipCryptoEngine | null } {
    if (headerBytes.length < 12) return { isValid: false, engine: null }

    const engine = new ZipCryptoEngine(password)
    let lastByte = 0
    for (let i = 0; i < 12; i++) {
      lastByte = engine.decryptByte(headerBytes[i])
    }

    const isValid = lastByte === (expectedCheckByte & 0xff)
    return { isValid, engine: isValid ? engine : null }
  }
}