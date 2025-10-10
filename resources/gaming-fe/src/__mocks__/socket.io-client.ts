const mockSocket = {
  on: jest.fn(),
  emit: jest.fn(),
  off: jest.fn(),
  disconnect: jest.fn(),
};

const io = jest.fn(() => mockSocket);

export default io;
export { io, mockSocket };
