import React from 'react';
import BloopersPanel from '@/components/studio/BloopersPanel';
import MyVoicePanel from '@/components/studio/MyVoicePanel';
import ProducePanel from '@/components/studio/ProducePanel';

// The owner's tools: his own voice (RVC), the full production chain and the
// Bloopers room. Loaded as its own chunk, only after the passphrase, and
// absent from the public build.
export default function OwnerPanels({ stems, mixParams, sessionName, onLock, onAddStem }) {
  return (
    <>
      <MyVoicePanel stems={stems} onAddStem={onAddStem} />
      <ProducePanel stems={stems} mixParams={mixParams} sessionName={sessionName} />
      <BloopersPanel stems={stems} mixParams={mixParams} sessionName={sessionName} onLock={onLock} />
    </>
  );
}
