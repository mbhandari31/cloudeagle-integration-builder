import { defineConnector, http, paginate, log } from "@cloudeagle/connector-sdk";

interface Ctx {
  since: string;
  state: { org?: string };
}

export default defineConnector({
  app: "calendly",
  baseUrl: "https://api.calendly.com",
  auth: {
    type: "oauth2",
    scopes: ["users:read", "organizations:read", "scheduled_events:read"],
  },

  async *users(ctx: Ctx) {
    const me = await http.get("/users/me"); // source: GET /users/me
    ctx.state.org = me.resource.current_organization;
    log(`organization ${ctx.state.org}`);
    yield* paginate("/organization_memberships", { // source: GET /organization_memberships
      query: { organization: ctx.state.org, count: 100 },
      next: (res: any) => res.pagination.next_page_token,
      items: (res: any) => res.collection,
      map: (m: any) => ({
        email: m.user.email,
        name: m.user.name,
        role: m.role,
        externalId: m.user.uri,
      }),
    });
  },

  async *usage(ctx: Ctx) {
    yield* paginate("/scheduled_events", { // source: GET /scheduled_events
      query: { organization: ctx.state.org, min_start_time: ctx.since, count: 100 },
      next: (res: any) => res.pagination.next_page_token,
      items: (res: any) => res.collection,
      map: (e: any) =>
        e.event_memberships.map((m: any) => ({ email: m.user_email, at: e.start_time })),
    });
  },
});
