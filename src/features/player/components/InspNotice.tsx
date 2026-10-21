import React from "react";
import { RefreshCw } from "lucide-react";
import { useT } from "../../../core/LanguageProvider";
import { Button } from "../../../components/ui/Button";
import "./MatchTab.css";

/**
 * El aviso de una pestaña del inspector: UNO, arriba, con la acción que lo
 * arregla. Debajo van solo los bloques que tienen datos.
 *
 * Antes cada bloque decía a su manera que faltaba algo (auditoría I3): una
 * partida sin sincronizar repetía el aviso en cuatro a seis sitios, dos de
 * ellos con «Reintentar» —que no arregla una partida sin sincronizar— y con el
 * error del backend metido en la frase.
 */
export interface InspNoticeProps {
  title: string;
  text?: string;
  /** El botón que lo arregla. Sin él, el aviso solo informa. */
  action?: React.ReactNode;
}

export const InspNotice: React.FC<InspNoticeProps> = ({ title, text, action }) => (
  <div className="mt-notice" role="status">
    <p className="mt-notice__title">{title}</p>
    {text && <p className="mt-notice__text">{text}</p>}
    {action && <div className="mt-notice__action">{action}</div>}
  </div>
);

/**
 * Partida sin sincronizar con Riot: lo único que la arregla es sincronizarla.
 * El botón es la acción oro de la pestaña y lleva su spinner dentro.
 */
export const SyncNotice: React.FC<{ text: string; syncing: boolean; onSync: () => void }> = ({ text, syncing, onSync }) => {
  const t = useT();
  return (
    <InspNotice
      title={t("This game isn't synced with Riot yet")}
      text={text}
      action={
        <Button
          variant="primary"
          size="sm"
          icon={<RefreshCw size={14} />}
          loading={syncing}
          loadingLabel={t("Syncing…")}
          onClick={onSync}
        >
          {t("Sync with Riot")}
        </Button>
      }
    />
  );
};
