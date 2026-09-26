/**
 * Mock Extranet domain state + workflow event emission (Component 11).
 *
 * This is a *safe, local* simulation. It never authenticates against anything
 * real and never stores secrets: the login endpoint accepts a username only and
 * ignores any password field entirely. Each domain action emits a
 * production-shaped workflow event so the Automation Lab can observe/analyze the
 * full workflow set without touching a production account.
 */

import { type WorkflowLabel, newId, type IdEnv, defaultIdEnv } from "./shared.ts";

export interface MockEvent {
  id: string;
  ts: number;
  workflow: WorkflowLabel;
  module: string;
  action: string;
  actor: string | null;
  refId?: string;
  detail: Record<string, unknown>;
}

export interface Property {
  id: string;
  name: string;
  address: string;
  status: "draft" | "active";
}
export interface Room {
  id: string;
  propertyId: string;
  name: string;
  roomType: string;
  capacity: number;
}
export interface Rate {
  id: string;
  roomId: string;
  label: string;
  amount: number;
  currency: string;
}
export interface Reservation {
  id: string;
  propertyId: string;
  roomId: string;
  guestName: string;
  checkIn: string;
  checkOut: string;
  status: "confirmed" | "cancelled";
}
export interface Message {
  id: string;
  reservationId: string | null;
  direction: "in" | "out";
  text: string;
}
export interface Review {
  id: string;
  propertyId: string;
  rating: number;
  text: string;
}
export interface Photo {
  id: string;
  propertyId: string;
  filename: string;
  sizeBytes: number;
}

export class MockError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "MockError";
  }
}

export interface MockOptions {
  idEnv?: IdEnv;
  clock?: () => number;
  maxEvents?: number;
}

export class MockExtranet {
  #idEnv: IdEnv;
  #clock: () => number;
  #maxEvents: number;

  actor: string | null = null;
  properties = new Map<string, Property>();
  rooms = new Map<string, Room>();
  rates = new Map<string, Rate>();
  reservations = new Map<string, Reservation>();
  messages = new Map<string, Message>();
  reviews = new Map<string, Review>();
  photos = new Map<string, Photo>();
  events: MockEvent[] = [];

  constructor(opts: MockOptions = {}) {
    this.#idEnv = opts.idEnv ?? defaultIdEnv;
    this.#clock = opts.clock ?? (() => Date.now());
    this.#maxEvents = opts.maxEvents ?? 5000;
  }

  #id(): string {
    return newId(this.#idEnv);
  }

  #emit(workflow: WorkflowLabel, module: string, action: string, detail: Record<string, unknown>, refId?: string): MockEvent {
    const ev: MockEvent = {
      id: this.#id(),
      ts: this.#clock(),
      workflow,
      module,
      action,
      actor: this.actor,
      ...(refId ? { refId } : {}),
      detail,
    };
    this.events.push(ev);
    if (this.events.length > this.#maxEvents) this.events.splice(0, this.events.length - this.#maxEvents);
    return ev;
  }

  #requireAuth(): void {
    if (!this.actor) throw new MockError(401, "not logged in");
  }

  // ---- LOGIN ----
  /** Accepts a username only; any password field is ignored and never stored. */
  login(username: string): MockEvent {
    if (!username || typeof username !== "string") throw new MockError(400, "username required");
    this.actor = username;
    return this.#emit("LOGIN", "auth", "login", { username });
  }
  logout(): MockEvent {
    const ev = this.#emit("LOGIN", "auth", "logout", {});
    this.actor = null;
    return ev;
  }

  // ---- PROPERTY_SETUP ----
  createProperty(name: string, address: string): Property {
    this.#requireAuth();
    if (!name) throw new MockError(400, "name required");
    const p: Property = { id: this.#id(), name, address: address ?? "", status: "draft" };
    this.properties.set(p.id, p);
    this.#emit("PROPERTY_SETUP", "property", "create", { name }, p.id);
    return p;
  }
  activateProperty(id: string): Property {
    this.#requireAuth();
    const p = this.properties.get(id);
    if (!p) throw new MockError(404, "property not found");
    p.status = "active";
    this.#emit("PROPERTY_SETUP", "property", "activate", {}, id);
    return p;
  }

  // ---- ROOM_SETUP ----
  createRoom(propertyId: string, name: string, roomType: string, capacity: number): Room {
    this.#requireAuth();
    if (!this.properties.has(propertyId)) throw new MockError(404, "property not found");
    const r: Room = { id: this.#id(), propertyId, name, roomType, capacity: capacity || 2 };
    this.rooms.set(r.id, r);
    this.#emit("ROOM_SETUP", "rooms", "create", { name, roomType, capacity: r.capacity }, r.id);
    return r;
  }

  // ---- RATE_SETUP ----
  setRate(roomId: string, label: string, amount: number, currency = "USD"): Rate {
    this.#requireAuth();
    if (!this.rooms.has(roomId)) throw new MockError(404, "room not found");
    if (!(amount > 0)) throw new MockError(400, "amount must be > 0");
    const rate: Rate = { id: this.#id(), roomId, label: label || "standard", amount, currency };
    this.rates.set(rate.id, rate);
    this.#emit("RATE_SETUP", "rates", "update", { label: rate.label, amount, currency }, rate.id);
    return rate;
  }

  // ---- RESERVATION ----
  createReservation(propertyId: string, roomId: string, guestName: string, checkIn: string, checkOut: string): Reservation {
    this.#requireAuth();
    if (!this.properties.has(propertyId)) throw new MockError(404, "property not found");
    if (!this.rooms.has(roomId)) throw new MockError(404, "room not found");
    const res: Reservation = {
      id: this.#id(),
      propertyId,
      roomId,
      guestName: guestName || "Test Guest",
      checkIn,
      checkOut,
      status: "confirmed",
    };
    this.reservations.set(res.id, res);
    this.#emit("RESERVATION", "reservations", "create", { checkIn, checkOut }, res.id);
    return res;
  }

  // ---- CANCELLATION ----
  cancelReservation(id: string): Reservation {
    this.#requireAuth();
    const res = this.reservations.get(id);
    if (!res) throw new MockError(404, "reservation not found");
    if (res.status === "cancelled") throw new MockError(409, "already cancelled");
    res.status = "cancelled";
    this.#emit("CANCELLATION", "reservations", "cancel", {}, id);
    return res;
  }

  // ---- MESSAGING ----
  sendMessage(reservationId: string | null, text: string): Message {
    this.#requireAuth();
    const m: Message = { id: this.#id(), reservationId, direction: "out", text: text ?? "" };
    this.messages.set(m.id, m);
    // detail carries length only, not the message text (privacy).
    this.#emit("MESSAGING", "messages", "send", { length: (text ?? "").length }, m.id);
    return m;
  }

  // ---- REVIEW ----
  addReview(propertyId: string, rating: number, text: string): Review {
    this.#requireAuth();
    if (!this.properties.has(propertyId)) throw new MockError(404, "property not found");
    if (!(rating >= 1 && rating <= 5)) throw new MockError(400, "rating must be 1..5");
    const rev: Review = { id: this.#id(), propertyId, rating, text: text ?? "" };
    this.reviews.set(rev.id, rev);
    this.#emit("REVIEW", "reviews", "create", { rating }, rev.id);
    return rev;
  }

  // ---- PHOTO (metadata only — no real upload) ----
  uploadPhoto(propertyId: string, filename: string, sizeBytes: number): Photo {
    this.#requireAuth();
    if (!this.properties.has(propertyId)) throw new MockError(404, "property not found");
    const ph: Photo = { id: this.#id(), propertyId, filename: filename || "photo.jpg", sizeBytes: sizeBytes || 0 };
    this.photos.set(ph.id, ph);
    this.#emit("PHOTO", "photos", "upload", { filename: ph.filename, sizeBytes: ph.sizeBytes }, ph.id);
    return ph;
  }

  // ---- REPORTING ----
  generateReport(propertyId: string): Record<string, unknown> {
    this.#requireAuth();
    if (!this.properties.has(propertyId)) throw new MockError(404, "property not found");
    const rooms = [...this.rooms.values()].filter((r) => r.propertyId === propertyId);
    const reservations = [...this.reservations.values()].filter((r) => r.propertyId === propertyId);
    const report = {
      propertyId,
      rooms: rooms.length,
      reservations: reservations.length,
      confirmed: reservations.filter((r) => r.status === "confirmed").length,
      cancelled: reservations.filter((r) => r.status === "cancelled").length,
      reviews: [...this.reviews.values()].filter((r) => r.propertyId === propertyId).length,
    };
    this.#emit("REPORTING", "reports", "generate", report, propertyId);
    return report;
  }

  /** Events since a given index (for the observability feed). */
  eventsSince(index: number): MockEvent[] {
    return this.events.slice(Math.max(0, index));
  }

  /** Rendered timeline (HH:MM:SS WORKFLOW) — mirrors docs/03. */
  timeline(): Array<{ ts: number; workflow: WorkflowLabel; action: string }> {
    return this.events.map((e) => ({ ts: e.ts, workflow: e.workflow, action: e.action }));
  }
}
