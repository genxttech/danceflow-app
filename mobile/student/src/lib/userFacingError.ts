/*
  An error whose message is meant to be read by a dancer: wording this app or the DanceFlow web API wrote
  for people ("That time was just taken", "Add a message first"). friendlyMessage shows the text of this
  class only; any other caught error (a database error, the payment SDK, a failed fetch) never reaches the
  screen and the screen's own fallback is used instead. Throw it only with text that is safe to show.
*/
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return error instanceof UserFacingError;
}
