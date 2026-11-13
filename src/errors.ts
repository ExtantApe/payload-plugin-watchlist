import { APIError } from 'payload'

/** Someone else decided first. */
export class AlreadyDecided extends APIError {
  constructor() {
    super('Another curator has already decided on this video.', 409, undefined, true)
    this.name = 'AlreadyDecided'
  }
}

/** A record that points at another site's record. */
export class CrossSite extends APIError {
  constructor() {
    super('A video and its creator must be on the same site.', 400, undefined, true)
    this.name = 'CrossSite'
  }
}
