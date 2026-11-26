"use client";

// A donor's name anywhere on the Sankalpam page opens their giving profile - the same one a WhatsApp
// chat shows. One dialog for the whole page, opened from wherever a name is.

import { createContext, useContext, useState, type ReactNode } from "react";
import { DonorProfileDialog } from "@/components/whatsapp/donor-profile";

interface Who {
  id: string;
  name: string;
  phone: string | null;
}

const Ctx = createContext<(who: Who) => void>(() => undefined);

export const useDonorProfile = () => useContext(Ctx);

export function DonorProfileProvider({ children }: { children: ReactNode }) {
  const [who, setWho] = useState<Who | null>(null);
  return (
    <Ctx.Provider value={setWho}>
      {children}
      {who && (
        <DonorProfileDialog
          url={`/api/sankalpam/donors/${who.id}/profile`}
          name={who.name}
          phone={who.phone ?? "No mobile number"}
          onClose={() => setWho(null)}
        />
      )}
    </Ctx.Provider>
  );
}
