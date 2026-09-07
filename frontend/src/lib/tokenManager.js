export function getTodayDateString() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function initializeTokenSystem() {
  const today = getTodayDateString();
  const lastTokenDate = localStorage.getItem("lastTokenDate");
  const lastTokenNumber = localStorage.getItem("lastTokenNumber");

  if (lastTokenDate !== today) {
    localStorage.setItem("lastTokenDate", today);
    localStorage.setItem("lastTokenNumber", "0");
  } else if (lastTokenNumber === null) {
    localStorage.setItem("lastTokenNumber", "0");
  }
}

export function getCurrentToken() {
  initializeTokenSystem();
  const num = parseInt(localStorage.getItem("lastTokenNumber") || "0", 10);
  return num === 0 ? 1 : num;
}

export function incrementToken() {
  initializeTokenSystem();
  const currentToken = parseInt(localStorage.getItem("lastTokenNumber") || "0", 10);
  const nextToken = currentToken + 1;
  localStorage.setItem("lastTokenNumber", String(nextToken));
  return nextToken;
}

export function resetToken() {
  localStorage.setItem("lastTokenNumber", "0");
  localStorage.setItem("lastTokenDate", getTodayDateString());
  window.dispatchEvent(new Event("tokenReset"));
}

