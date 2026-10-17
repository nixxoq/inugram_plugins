export class CorruptedArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CorruptedArchiveError'
  }
}

export class SizeLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SizeLimitError'
  }
}

export class SecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
  }
}

export class UnsupportedArchiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedArchiveError'
  }
}

export class ZipBombError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ZipBombError'
  }
}

export class IndeterminateFilePresenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'IndeterminateFilePresenceError'
  }
}

export class PublishError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublishError'
  }
}

export class CancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CancelledError'
  }
}

export class SessionQuotaExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionQuotaExceededError'
  }
}

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export class TruncatedEntryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TruncatedEntryError'
  }
}

export class UnsupportedCompressionMethodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedCompressionMethodError'
  }
}

export class PasswordRequiredError extends Error {
  constructor(message: string = 'Archive is password-protected') {
    super(message)
    this.name = 'PasswordRequiredError'
  }
}

export class InvalidPasswordError extends Error {
  constructor(message: string = 'Wrong archive password') {
    super(message)
    this.name = 'InvalidPasswordError'
  }
}

