import { Subject } from 'rxjs'


export interface DeliverMessage {
  deliverMessage: string;
}
export interface SocketEnabled {
  socketEnabled: boolean;
}
export interface WasmMove {
  wasmMove: string;
}
export interface SetCardSelections {
  setCardSelections: number;
}
export interface Shutdown {
  // TODO: Did we add a string or Enum here?
  shutdown: boolean;
}

export type WasmCommand = DeliverMessage | SocketEnabled | WasmMove | SetCardSelections | Shutdown;

export const wasmCommandChannel = new Subject<WasmCommand>();

