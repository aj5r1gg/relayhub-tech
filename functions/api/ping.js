export async function onRequestGet() {
  return new Response("RelayHub function is working", {
    headers: { "content-type": "text/plain" },
  });
}
