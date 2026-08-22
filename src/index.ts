export default {
	async fetch(request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/api/hello") {
			return Response.json({ hello: "world" });
		}
		return new Response("Hello from worker-template");
	},
} satisfies ExportedHandler<Env>;
