"use strict";

exports.handler = async function health() {
  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    },
    body: JSON.stringify({
      status: "ok",
      service: "well-pump-control",
      phase: "observational-pilot",
      controlAuthority: false,
      timestamp: new Date().toISOString()
    })
  };
};
