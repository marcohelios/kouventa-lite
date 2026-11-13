/** Error carrying the HTTP status a route should answer with. */
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
