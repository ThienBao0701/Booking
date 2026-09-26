/**
 * Page map (page-object model) of the mock Extranet UI — the element contract
 * MockExtranetController drives. It mirrors mock-extranet/src/ui.ts: element
 * ids, data attributes, HTML default values and the request each action
 * button sends. tests/e2e/controller.e2e.test.ts verifies every id here
 * against the HTML the running mock actually serves, so drift fails CI.
 */

export type EntityKind = "property" | "room" | "reservation" | "rate" | "message" | "review" | "photo";

export interface FieldSpec {
  id: string;
  tag: "input" | "select" | "textarea";
  /** HTML default value (value="…"). */
  defaultValue?: string;
  /** For <select>: options are the ids of this entity kind (first option is the default). */
  options?: EntityKind;
}

export interface ActionSpec {
  id: string;
  dataAction: string;
  /** Build the request exactly as the mock UI's client script does. */
  request: (field: (id: string) => string) => { path: string; body: Record<string, unknown> };
  /** Entity created by a successful response: `response[responseKey].id`. */
  creates?: { kind: EntityKind; responseKey: string };
  effect?: "login" | "report";
}

export interface ViewSpec {
  name: string;
  fields: FieldSpec[];
  actions: ActionSpec[];
  /** Other element ids rendered inside this view. */
  staticIds: string[];
}

export const MOCK_APP_MARKER = 'data-app="mock-extranet"';
export const DEFAULT_VIEW = "login";
/** Elements outside any view (always present). */
export const GLOBAL_IDS = ["nav", "actor", "feed"];

/** `num()` in the mock client script: Number(v || 0). */
const num = (v: string): number => Number(v || 0);

export const VIEWS: readonly ViewSpec[] = [
  {
    name: "login",
    fields: [{ id: "login-username", tag: "input" }],
    actions: [
      {
        id: "login-submit",
        dataAction: "login",
        request: (f) => ({ path: "/api/login", body: { username: f("login-username") } }),
        effect: "login",
      },
    ],
    staticIds: [],
  },
  {
    name: "property",
    fields: [
      { id: "prop-name", tag: "input" },
      { id: "prop-address", tag: "input" },
    ],
    actions: [
      {
        id: "prop-submit",
        dataAction: "createProperty",
        request: (f) => ({ path: "/api/properties", body: { name: f("prop-name"), address: f("prop-address") } }),
        creates: { kind: "property", responseKey: "property" },
      },
    ],
    staticIds: ["prop-table"],
  },
  {
    name: "rooms",
    fields: [
      { id: "room-property", tag: "select", options: "property" },
      { id: "room-name", tag: "input" },
      { id: "room-type", tag: "input" },
      { id: "room-capacity", tag: "input", defaultValue: "2" },
    ],
    actions: [
      {
        id: "room-submit",
        dataAction: "createRoom",
        request: (f) => ({
          path: "/api/rooms",
          body: { propertyId: f("room-property"), name: f("room-name"), roomType: f("room-type"), capacity: num(f("room-capacity")) },
        }),
        creates: { kind: "room", responseKey: "room" },
      },
    ],
    staticIds: ["room-table"],
  },
  {
    name: "rates",
    fields: [
      { id: "rate-room", tag: "select", options: "room" },
      { id: "rate-label", tag: "input", defaultValue: "standard" },
      { id: "rate-amount", tag: "input", defaultValue: "120" },
    ],
    actions: [
      {
        id: "rate-submit",
        dataAction: "setRate",
        request: (f) => ({ path: "/api/rates", body: { roomId: f("rate-room"), label: f("rate-label"), amount: num(f("rate-amount")) } }),
        creates: { kind: "rate", responseKey: "rate" },
      },
    ],
    staticIds: [],
  },
  {
    name: "reservations",
    fields: [
      { id: "res-property", tag: "select", options: "property" },
      { id: "res-room", tag: "select", options: "room" },
      { id: "res-guest", tag: "input" },
      { id: "res-in", tag: "input" },
      { id: "res-out", tag: "input" },
    ],
    actions: [
      {
        id: "res-submit",
        dataAction: "createReservation",
        request: (f) => ({
          path: "/api/reservations",
          body: {
            propertyId: f("res-property"),
            roomId: f("res-room"),
            guestName: f("res-guest"),
            checkIn: f("res-in"),
            checkOut: f("res-out"),
          },
        }),
        creates: { kind: "reservation", responseKey: "reservation" },
      },
    ],
    staticIds: ["res-table"],
  },
  {
    name: "messages",
    fields: [{ id: "msg-text", tag: "textarea" }],
    actions: [
      {
        id: "msg-submit",
        dataAction: "sendMessage",
        request: (f) => ({ path: "/api/messages", body: { reservationId: null, text: f("msg-text") } }),
        creates: { kind: "message", responseKey: "message" },
      },
    ],
    staticIds: [],
  },
  {
    name: "reviews",
    fields: [
      { id: "rev-property", tag: "select", options: "property" },
      { id: "rev-rating", tag: "input", defaultValue: "5" },
      { id: "rev-text", tag: "textarea" },
    ],
    actions: [
      {
        id: "rev-submit",
        dataAction: "addReview",
        request: (f) => ({ path: "/api/reviews", body: { propertyId: f("rev-property"), rating: num(f("rev-rating")), text: f("rev-text") } }),
        creates: { kind: "review", responseKey: "review" },
      },
    ],
    staticIds: [],
  },
  {
    name: "photos",
    fields: [
      { id: "photo-property", tag: "select", options: "property" },
      { id: "photo-name", tag: "input", defaultValue: "room.jpg" },
    ],
    actions: [
      {
        id: "photo-submit",
        dataAction: "uploadPhoto",
        request: (f) => ({ path: "/api/photos", body: { propertyId: f("photo-property"), filename: f("photo-name"), sizeBytes: 12345 } }),
        creates: { kind: "photo", responseKey: "photo" },
      },
    ],
    staticIds: [],
  },
  {
    name: "reports",
    fields: [{ id: "report-property", tag: "select", options: "property" }],
    actions: [
      {
        id: "report-submit",
        dataAction: "generateReport",
        request: (f) => ({ path: "/api/reports", body: { propertyId: f("report-property") } }),
        effect: "report",
      },
    ],
    staticIds: ["report-out"],
  },
];

/** API listing endpoint used to populate a <select> of an entity kind. */
export const OPTION_SOURCES: Partial<Record<EntityKind, { path: string; key: string }>> = {
  property: { path: "/api/properties", key: "properties" },
  room: { path: "/api/rooms", key: "rooms" },
  reservation: { path: "/api/reservations", key: "reservations" },
};

export function findView(name: string): ViewSpec | undefined {
  return VIEWS.find((v) => v.name === name);
}

/** Every element id the page map expects the mock to render. */
export function allElementIds(): string[] {
  return [
    ...GLOBAL_IDS,
    ...VIEWS.flatMap((v) => [...v.fields.map((f) => f.id), ...v.actions.map((a) => a.id), ...v.staticIds]),
  ];
}
