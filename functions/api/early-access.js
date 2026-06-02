export async function onRequestPost({ request }) {
  const form = await request.formData();

  const name = String(form.get("name") || "").trim();
  const email = String(form.get("email") || "").trim();

  return new Response(`Received early access form for ${name} <${email}>`, {
    status: 200,
    headers: {
      "content-type": "text/plain",
    },
  });
}

export async function onRequestGet() {
  return new Response("Early access endpoint is live. Submit the form with POST.", {
    status: 200,
    headers: {
      "content-type": "text/plain",
    },
  });
}
