import "next-auth";
import "next-auth/jwt";

export type AppRole = "admin" | "operator" | "viewer";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
      githubUsername?: string;
      isMaintainer?: boolean;
      role?: AppRole;
      csrfToken?: string;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    githubId?: string;
    githubUsername?: string;
    isMaintainer?: boolean;
    role?: AppRole;
  }
}