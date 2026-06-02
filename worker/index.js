export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/early-access") {
      if (request.method === "GET") {
        return new Response(
          "Early access endpoint is live. Submit the form with POST.",
          {
            status: 200,
            headers: {
              "content-type": "text/plain",
            },
          },
        );
      }

      if (request.method !== "POST") {
        return new Response("Method not allowed", {
          status: 405,
        });
      }

      const form = await request.formData();

      const data = {
        name: String(form.get("name") || "").trim(),
        email: String(form.get("email") || "").trim(),
        interest: String(form.get("interest") || "").trim(),
        product: String(form.get("product") || "").trim(),
        location: String(form.get("location") || "").trim(),
        testing: String(form.get("testing") || "").trim(),
        message: String(form.get("message") || "").trim(),
        submittedAt: new Date().toISOString(),
      };

      console.log(
        JSON.stringify({
          event: "early-access",
          ...data,
        }),
      );

      return Response.redirect(
        `${url.origin}/early-access?submitted=true`,
        303,
      );
    }

    return env.ASSETS.fetch(request);
  },
};