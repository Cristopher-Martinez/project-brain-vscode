import express from "express";

const app = express();

app.get("/api/users", (req, res) => {
  res.json([{ id: 1, name: "Alice" }]);
});

app.post("/api/users", (req, res) => {
  res.status(201).json({ id: 2, name: "Bob" });
});

export function helper(x: number): number {
  return x * 2;
}

export class UserService {
  private users: string[] = [];

  addUser(name: string): void {
    this.users.push(name);
  }

  getUsers(): string[] {
    return [...this.users];
  }
}

export default app;
