export async function onRequestPost({ request }) {
  const form = await request.formData();

  const name = form.get("name");
  const email = form.get("email");

  return new Response(`Received early access form for ${name} <${email}>`, {
    status: 200,
    headers: {
      "content-type": "text/plain",
    },
  });
}