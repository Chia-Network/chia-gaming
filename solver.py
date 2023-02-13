import inspect
import sqlite3
import binascii
from chia.types.blockchain_format.program import Program
from clvm_tools.binutils import assemble, disassemble

class TestObject:
    def __init__(self):
        self.the_bytes = b"TestObject bytes"

TEST=b'982348328432'
TEST_OBJ=TestObject()

def flatten(lists):
    return [item for sub_list in lists for item in sub_list]

class FromHere:
    def __init__(self,frames):
        self.frames = frames

    def get_all_variables(self):
        return flatten(map(lambda f: f.get_all_variables(), self.frames))

class StackScope:
    def __init__(self,frameno,variables):
        self.frameno = frameno
        self.variables = variables

    def get_all_variables(self):
        def rename_variable(nv):
            n, v = nv
            return (f"frame{self.frameno}.{n}", v)

        return flatten(map(lambda var: map(rename_variable, var.get_all_variables()), self.variables))

class VariableInScope:
    def __init__(self,name,value):
        self.name = name
        self.value = value

    def get_all_variables(self):
        return [(f"{self.name}", self.value)]

class Object:
    def __init__(self,members):
        self.members = members

    def get_all_variables(self):
        return flatten(map(lambda mem: mem.get_all_variables(), self.members))

#
# Gather values from the reachable objects observable from here.
#
def gather_knowledge(visited):
    stack_frames = inspect.stack()

    def make_variable(nv):
        name, obj = nv

        objid = id(obj)
        if objid in visited:
            return []

        visited.add(objid)

        if obj.__class__ is bytes:
            return [VariableInScope(name,obj)]
        elif obj.__class__ is str:
            return [VariableInScope(name,obj)]
        elif obj.__class__ is float:
            return []
        elif obj.__class__.__name__ == 'module':
            return []
        elif obj.__class__.__name__ == 'function':
            return []
        elif obj.__class__.__name__ == 'method-wrapper':
            return []
        elif obj.__class__.__name__ == 'wrapper_descriptor':
            return []
        elif obj.__class__.__name__ == 'method_descriptor':
            return []
        elif 'builtin' in obj.__class__.__name__:
            return []

        inspect_members = inspect.getmembers(obj)
        members = flatten(map(make_variable, inspect_members))
        return [Object(members)]

    def make_stack_frame(iframe):
        i, frame = iframe
        variables = flatten(map(make_variable, frame.frame.f_locals.items()))
        return StackScope(i,variables)

    our_frame_objects = map(make_stack_frame, enumerate(stack_frames))
    return FromHere(our_frame_objects)

class HashGuesser:
    def __init__(self,name):
        self.conn = sqlite3.connect(name)
        self.create_schema()

    def create_schema(self):
        cursor = self.conn.cursor()
        cursor.execute("create table if not exists hashes (path, desc, program, hash)")

    def get_hash_inputs_if_known(self,hashhex):
        cursor = self.conn.cursor()
        cursor.execute("select * from hashes where hash = ?", (hashhex,))

        for row in cursor:
            return {
                'path': row[0],
                'desc': row[1],
                'program': row[2],
                'hashhex': row[3]
            }

        return None

    def get_program_hash_if_known(self,program):
        cursor = self.conn.cursor()
        cursor.execute("select hash from hashes where program = ?", (str(program),))

        for row in cursor:
            return row[0]

        return None

    def insert_hash(self,path,desc,program,hashhex):
        the_input = self.get_hash_inputs_if_known(hashhex)
        if the_input is None:
            cursor = self.conn.cursor()
            cursor.execute("insert into hashes (path,desc,program,hash) values (?,?,?,?)", (str(path),str(desc),str(program),hashhex))
            self.conn.commit()

    def sha256tree_internal(self,anything,path=None):
        try:
            converted = Program.to(anything)
        except:
            return None

        # If we already have it, there's no need to go farther
        maybe_hash = self.get_program_hash_if_known(converted)
        if maybe_hash is not None:
            return maybe_hash

        # It's a tree: also intern descendants in case we need them,
        try:
            if converted.pair is not None:
                self.sha256tree_internal(converted.pair[0], path=self.path + ".pair[0]")
                self.sha256tree_internal(converted.pair[1], pait=self.path + ".pair[1]")
        except:
            pass

        hashed = binascii.hexlify(converted.get_tree_hash()).decode('utf8')
        self.insert_hash(path,anything,converted,hashed)
        return hashed

    def add_known(self,vpairs):
        for name, value in vpairs:
            self.sha256tree_internal(value, path=name)

    def recursion_check(self,maybe_in,x):
        xstr = str(x)
        queue = [maybe_in]
        while len(queue):
            first = queue.pop(0)
            pstr = str(first)

            if pstr == xstr:
                return True

            try:
                if first.pair is not None:
                    queue.push(first.pair[0])
                    queue.push(first.pair[1])
            except:
                pass

        # Not recursive
        return False

    # Given fault program, try replacing inputs until we guess the correct
    # one.  Do this in BFS order so we terminate as early as possible as
    # the erroneous part is likely one branch of a program.
    def guess_hash_input(self,target_hash,faulty_program):
        def check_main_hash(x):
            program = Program.to(x)
            hashed = self.sha256tree_internal(program)
            return hashed

        queue = [(faulty_program, check_main_hash)]
        while len(queue):
            program,check_target = queue.pop(0)

            def check_right_sibling(left_sibling,check_target):
                def check(x):
                    try_program = Program.to((x,left_sibling))
                    return check_target(try_program)

                return check

            def check_left_sibling(right_sibling,check_target):
                def check(x):
                    try_program = Program.to((right_sibling,x))
                    return check_target(try_program)

                return check

            def filter_kind_of_sexp(pairs):
                return lambda row: (row[0].startswith('ff') == pairs)

            # The program we're looking at wasn't a pair so we'll try the inputs
            # we have.  We can do a search of the entire tree space but there's
            # no limit to the inputs we can construct.  We'll assume the user
            # got the shape right.
            ppair = program.pair
            has_pair = ppair is not None
            if has_pair:
                queue = [(ppair[0], check_right_sibling(ppair[1],check_target))] + queue
                queue = [(ppair[1], check_left_sibling(ppair[0],check_target))] + queue

            cursor = self.conn.cursor()
            cursor.execute("select program,path from hashes")

            rows = filter(filter_kind_of_sexp(has_pair), cursor.fetchall())
            for row in rows:
                program = Program.fromhex(row[0])
                if not self.recursion_check(faulty_program, program):
                    check_hash = check_target(program)
                    if check_hash == target_hash:
                        return (row[0],row[1])

            if check_target(program) == target_hash:
                return (None, "nil")


if __name__ == '__main__':
    visited = set()
    known = gather_knowledge(visited)

    h = HashGuesser('test.db')
    h.add_known(known.get_all_variables())

    want_program = Program.to([TEST, TEST_OBJ.the_bytes])
    want_hash = binascii.hexlify(want_program.get_tree_hash()).decode('utf8')
    print(f'want {want_hash} {disassemble(want_program)}')
    wrong_program = Program.to([TEST, b"wrong thing"])
    guess = h.guess_hash_input(want_hash, wrong_program)
    print(disassemble(Program.fromhex(guess[0])), guess[1])
