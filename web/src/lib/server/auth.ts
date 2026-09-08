export const authHeaders = new Headers({
  Accept: "application/json",
  "Content-Type": "application/json",
  Authorization: "Bearer " + process.env.TOKEN,
});

// authHeaders.append("Content-Type", "application/json");
// authHeaders.append("Authorization", "Bearer " + env.TOKEN);
